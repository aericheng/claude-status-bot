// Claude Status watcher
// 整合 Claude 服務狀態（status.claude.com 公開 API）與本帳號用量（OAuth usage API），
// 以 Discord Webhook 維護一則自動更新的儀表板訊息；事故新增/更新/解決與用量跨閾值時另發警報
//（閾值 80% 起每 5% 一階，跨過各報一次）。
// 另監控 NYCU 校園停電公告（十三舍相關；總務處＋住服組兩來源，預設每 30 分鐘），有新公告即發警報。
// 無 npm 依賴（Node 18+ 全域 fetch）。用法：
//   node watcher.js          常駐，每 pollMinutes 分鐘更新一次
//   node watcher.js --once   跑一輪就結束（測試/排程用）
//   node watcher.js --dry    只印出會發送的內容，不打 Discord（測試用）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const CREDENTIALS_PATH = 'C:/Users/user/.claude/.credentials.json';

const STATUS_SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';
const STATUS_INCIDENTS_URL = 'https://status.claude.com/api/v2/incidents.json';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// statusline（~/.claude/statusline-command.sh）也打同一支 usage API，並以 90 秒檔案快取落在這裡。
// 該 API 有帳號級限流且無公開文件（2026-09-07 實測：3 個 Claude Code session 開著時 watcher 幾乎每輪 429，
// retry-after 0，一次被鎖常達整小時），故 watcher 改為與 statusline 共用這份快取：
// 快取夠新就直接用、自己打成功也寫回，兩個消費者合計只打一份的量。
const USAGE_CACHE_PATH = 'C:/Users/user/.claude/sl-usage-cache.json';
const USAGE_CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 快取在這個時間內視為最新，不打 API
const USAGE_BACKOFF_MS = 10 * 60 * 1000; // 被 429 之後暫停打 API 的時間（期間沿用舊值顯示）
const AVATAR_URL =
  'https://dka575ofm4ao0.cloudfront.net/pages-email_logos/original/362807/NEW_claude_status_email.png-d88779a1-c7b3-456d-b84e-1d0cdd4614e9.png';

// 停電公告監控來源（十三舍＝光復校區；兩頁皆為 server-rendered HTML，2026-08-26 實測可直接 fetch）
// 十三舍停電多為總務處營繕二組自辦工程，不會出現在台電對外停電資料，故只爬校內公告
const OUTAGE_SOURCES = [
  {
    key: 'ga',
    name: '總務處 停水電空調',
    base: 'https://ga.nycu.edu.tw',
    url: 'https://ga.nycu.edu.tw/ga/ch/app/news/list?module=headnews&id=5303&dataClass=53d910fb-d1e6-4fe4-9cd4-f738d70c5c63',
  },
  {
    key: 'osa',
    name: '住服組 交大校區宿舍',
    base: 'https://www.nycu.edu.tw',
    url: 'https://www.nycu.edu.tw/osa/ch/app/data/list?module=nycu0084&id=3465',
  },
];

const args = process.argv.slice(2);
const ONCE = args.includes('--once') || args.includes('--dry');
const DRY = args.includes('--dry');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

// 台灣時間顯示（MM/DD HH:mm）
function tw(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 彩色進度條：每格 10%，顏色隨用量升級（<50 綠、50-79 黃、80-94 橙、≥95 紅）
function colorBar(pct) {
  const seg = pct >= 95 ? '🟥' : pct >= 80 ? '🟧' : pct >= 50 ? '🟨' : '🟩';
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return seg.repeat(n) + '⬜'.repeat(10 - n);
}

function stripHtml(t) {
  return String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 民國日期（115-07-14）→ Date；解析失敗回 null
function rocDate(s) {
  const m = /(\d{2,3})-(\d{1,2})-(\d{1,2})/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1] + 1911, +m[2] - 1, +m[3])) : null;
}

// ===== 資料抓取 =====
async function fetchStatus() {
  const [summary, incidents] = await Promise.all([
    fetch(STATUS_SUMMARY_URL).then((r) => r.json()),
    fetch(STATUS_INCIDENTS_URL).then((r) => r.json()),
  ]);
  return { summary, incidents: incidents.incidents || [] };
}

// 讀 statusline 共用快取；回 { data, at }（at＝檔案 mtime，ms），檔案不存在／半截／非用量回應體時回 null
function readUsageCache() {
  try {
    const st = fs.statSync(USAGE_CACHE_PATH);
    const data = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    if (!data || !data.five_hour || !data.seven_day) return null;
    return { data, at: st.mtimeMs };
  } catch (_) {
    return null;
  }
}

// 與 statusline 同格式（API 原始 JSON）、tmp＋rename 原子替換；tmp 名稱與 statusline 的 .tmp 錯開
function writeUsageCache(data) {
  const tmp = USAGE_CACHE_PATH + '.watcher.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, USAGE_CACHE_PATH);
}

let usageBackoffUntil = 0;

// 回傳 { data, at, source, note, stale }：
//   data  ＝本輪可用的用量（快取或 API），null＝本輪拿不到新資料（警報水位不動）
//   at    ＝data 的資料時間（ms）；source＝'cache'|'api'
//   note  ＝拿不到的原因（顯示在儀表板與 log）；stale＝過期的快取（有就拿來顯示上一次成功值）
// 401／429／token 過期都是已知狀況，走 note 不 throw；只有非預期錯誤才 throw
async function fetchUsage() {
  const cached = readUsageCache();
  const degraded = (note) => ({ data: null, note, stale: cached });

  // 1. statusline 剛抓過的就直接用，不再打 API
  if (cached && Date.now() - cached.at < USAGE_CACHE_MAX_AGE_MS) return { ...cached, source: 'cache' };

  // 2. token 已過期＝Claude Code 尚未 refresh（watcher 只讀檔、不自己 refresh），打了必 401，跳過等下一輪
  const cred = loadJson(CREDENTIALS_PATH, {});
  const oauth = cred.claudeAiOauth || {};
  if (!oauth.accessToken) throw new Error('credentials 檔內找不到 claudeAiOauth.accessToken');
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) return degraded('token 已過期，等待 Claude Code 更新');
  if (Date.now() < usageBackoffUntil) return degraded('API 限流退避中');

  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (res.status === 429) {
    usageBackoffUntil = Date.now() + USAGE_BACKOFF_MS;
    return degraded('API 限流（HTTP 429）');
  }
  if (res.status === 401) return degraded('token 失效（HTTP 401）');
  if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
  const data = await res.json();
  if (!DRY) {
    try {
      writeUsageCache(data); // 讓 statusline 也吃到這份，省下它的下一次呼叫
    } catch (e) {
      log('usage cache write failed: ' + e.message);
    }
  }
  return { data, at: Date.now(), source: 'api' };
}

// ===== Discord webhook =====
let postsThisTick = 0; // 本輪發出的訊息數（停電／事故／用量通報）；>0 表示儀表板被擠上去了，輪末重發到最底

async function webhookPost(config, payload) {
  postsThisTick++;
  if (DRY) {
    log('DRY post: ' + JSON.stringify(payload).slice(0, 800));
    return { id: 'dry-run' };
  }
  const res = await fetch(`${config.webhookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Claude Status', avatar_url: AVATAR_URL, ...payload }),
  });
  if (!res.ok) throw new Error(`webhook POST HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function webhookDelete(config, messageId) {
  if (DRY) {
    log('DRY delete ' + messageId);
    return;
  }
  const res = await fetch(`${config.webhookUrl}/messages/${messageId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`webhook DELETE HTTP ${res.status}`);
}

async function webhookEdit(config, messageId, payload) {
  if (DRY) {
    log('DRY edit ' + messageId + ': ' + JSON.stringify(payload).slice(0, 800));
    return true;
  }
  const res = await fetch(`${config.webhookUrl}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) return false; // 訊息被刪了 → 呼叫端重發
  if (!res.ok) throw new Error(`webhook PATCH HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// ===== 儀表板組裝 =====
const IMPACT_EMOJI = { none: '🟢', minor: '🟡', major: '🟠', critical: '🔴' };

const STATUS_TEXT = { none: '正常運作', minor: '輕微異常', major: '部分服務異常', critical: '重大故障' };

// 極簡版：標題一句話狀態；內文一行用量＋進行中事故只列名稱（細節點標題連結看官網）
// usage 為 null＝本輪拿不到新資料：meta.stale 有值就顯示上一次成功的數值＋資料時間（meta.note 說明原因），
// 連舊值都沒有才顯示「無法取得」
function buildDashboard(status, usage, meta = {}) {
  const ind = (status.summary.status && status.summary.status.indicator) || 'none';
  const active = status.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');

  const color = ind === 'critical' || ind === 'major' ? 0xed4245 : ind === 'minor' ? 0xfee75c : 0x57f287;

  const hhmm = (t) =>
    new Date(t).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  const shown = usage || (meta.stale && meta.stale.data) || null;
  const scoped = shown ? (shown.limits || []).filter((l) => l.kind === 'weekly_scoped' && l.scope && l.scope.model) : [];

  const lines = [
    ...(shown
      ? [
          `${colorBar(shown.five_hour.utilization)} 5h **${shown.five_hour.utilization}%**（${hhmm(shown.five_hour.resets_at)} 重置）`,
          `${colorBar(shown.seven_day.utilization)} 週 **${shown.seven_day.utilization}%**`,
          ...scoped.map((l) => `${colorBar(l.percent)} ${l.scope.model.display_name} **${l.percent}%**`),
          ...(usage ? [] : [`⚠️ ${meta.note || '暫時無法更新'}，以上為 ${hhmm(meta.stale.at)} 的資料`]),
        ]
      : [`⚠️ 用量資料暫時無法取得（${meta.note || 'API 限流或逾時'}），恢復後自動補上`]),
    ...active.slice(0, 3).map((i) => `${IMPACT_EMOJI[i.impact] || '🚨'} ${i.name}（${i.status}）`),
  ];
  if (active.length > 3) lines.push(`…另有 ${active.length - 3} 件進行中`);

  return {
    embeds: [
      {
        title: `${IMPACT_EMOJI[ind] || '🟢'} Claude：${STATUS_TEXT[ind] || ind}`,
        url: 'https://status.claude.com',
        color,
        description: lines.join('\n'),
        footer: { text: '每 5 分鐘更新' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ===== 警報判斷 =====
// 回傳 { alerts: [{type:'new'|'update'|'usage', text, incidentId?}], toDelete: [messageId] }
// 規則：每件事故的新事故通知與更新警報各留一則（更新只留最新）；事故解決＝兩則一起撤下、不另發訊息。
// 頻道因此只剩「進行中的事故」＋儀表板，解決的事故不留痕（細節看官網）。
const LINK_FOOTER = '\n-# [status.claude.com](<https://status.claude.com>)';

function collectAlerts(status, usage, state, config) {
  const alerts = [];
  const toDelete = [];
  const tracked = state.incidents || {};
  const nowTracked = {};
  const seen = new Set();
  const retire = (prev) => {
    // 事故解決（或從官方清單消失）：撤下該事故的新事故通知與更新警報，不發解決訊息
    if (prev.newAlertId) toDelete.push(prev.newAlertId);
    if (prev.updateAlertId) toDelete.push(prev.updateAlertId);
  };

  for (const i of status.incidents.slice(0, 30)) {
    seen.add(i.id);
    const latest = (i.incident_updates || [])[0];
    const latestAt = latest ? latest.created_at : i.created_at;
    const prev = tracked[i.id];
    const isActive = i.status !== 'resolved' && i.status !== 'postmortem';

    if (isActive) {
      nowTracked[i.id] = {
        latestAt,
        status: i.status,
        newAlertId: prev && prev.newAlertId,
        updateAlertId: prev && prev.updateAlertId,
      };
      if (!prev) {
        alerts.push({
          type: 'new',
          incidentId: i.id,
          text: `🚨 **新事故**：${i.name}（impact: ${i.impact}）\n> ${latest ? stripHtml(latest.body).slice(0, 200) : ''}${LINK_FOOTER}`,
        });
      } else if (prev.latestAt !== latestAt) {
        alerts.push({
          type: 'update',
          incidentId: i.id,
          text: `🔔 **事故更新**：${i.name}（${i.status}）\n> ${latest ? stripHtml(latest.body).slice(0, 200) : ''}`,
        });
      }
    } else if (prev) {
      retire(prev);
    }
  }
  // 追蹤中但這次官方清單裡沒有的（掉出前 30 筆）：視同已解決，一併撤下，否則通知會永遠留在頻道
  for (const id of Object.keys(tracked)) if (!seen.has(id)) retire(tracked[id]);
  state.incidents = nowTracked;

  // 用量閾值（跨過才報一次；視窗重置後歸零）；usage 失敗的輪次跳過，水位不動
  const thresholds = config.usageThresholds || [80, 85, 90, 95, 100];
  state.usage = state.usage || {};
  const metrics = !usage ? [] : [
    ['5 小時限制', 'five_hour', usage.five_hour.utilization, usage.five_hour.resets_at],
    ['一週限制', 'seven_day', usage.seven_day.utilization, usage.seven_day.resets_at],
    ...(usage.limits || [])
      .filter((l) => l.kind === 'weekly_scoped' && l.scope && l.scope.model)
      .map((l) => [`${l.scope.model.display_name} 週限制`, `scoped_${l.scope.model.display_name}`, l.percent, l.resets_at]),
  ];
  for (const [label, key, pct, resetsAtRaw] of metrics) {
    // API 的 resets_at 小數秒每次呼叫都不同，截到秒級再比對（否則每 tick 誤判新視窗→重複警報）
    const resetsAt = String(resetsAtRaw).slice(0, 19);
    const m = state.usage[key] || { alerted: 0, resetsAt: null };
    if (m.resetsAt && m.resetsAt !== resetsAt) m.alerted = 0; // 新視窗
    m.resetsAt = resetsAt;
    const crossed = thresholds.filter((t) => pct >= t && m.alerted < t);
    if (crossed.length) {
      m.alerted = Math.max(...crossed); // 一個 tick 跨多個閾值只發一則
      alerts.push({ type: 'usage', text: `⚡ **用量警報**：${label}已達 **${pct}%**（${tw(resetsAtRaw)} 重置）` });
    }
    state.usage[key] = m;
  }

  return { alerts, toDelete };
}

// ===== 停電公告監控 =====
// 列表項格式（兩來源同構）：<a id="listImageNumN" href="..." title="...">…發布/更新日期：115-07-14
function parseAnnouncements(html, source) {
  const items = [];
  const re = /<a\s+id="listImageNum\d+"\s+href="([^"]+)"\s+title="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeEntities(m[1]);
    const title = decodeEntities(m[2])
      .replace(/\(開啟新視窗\)/g, '')
      .replace(/\((?:doc|docx|pdf|odt)\)/gi, '')
      .trim();
    const tail = html.slice(re.lastIndex, re.lastIndex + 600);
    const dm = /(?:發布|更新)日期：\s*([\d-]+)/.exec(tail);
    items.push({
      id: source.key + ':' + href,
      url: href.startsWith('http') ? href : source.base + href,
      title,
      dateText: dm ? dm[1] : '',
      date: dm ? rocDate(dm[1]) : null,
      source,
    });
  }
  return items;
}

// 十三舍相關性判斷（只能看標題：doc 型公告是純附件、無內文頁）。
// 原則：寧可多報不可漏報——只有「明確點名其他地點且未含十三舍」才略過。
// 回傳 'direct'（點名十三舍）｜'broad'（全校/光復/宿舍區級）｜'unknown'（標題沒講範圍）｜null（不相關）
function outageRelevance(title) {
  if (!/停電|電力/.test(title)) return null;
  if (/十三舍|13舍/.test(title)) return 'direct';
  if (/全校|全區|光復|交大校區|各宿舍|宿舍區/.test(title)) return 'broad';
  if (/舍|館|大樓|校區|齋|中心|棟/.test(title)) return null;
  return 'unknown';
}

// 本機常駐服務的排程任務對應表（新 bot 上排程後在這裡補一行，未列的 Running 任務仍會以原名列出）
const KNOWN_TASKS = {
  ClaudeStatusWatcher: { label: 'Claude Status watcher（本儀表板）', kind: 'resident' },
  PlaneDiscordBot: { label: 'Plane Discord bot', kind: 'resident' },
  ClaudeLearningBot: { label: 'Claude 學習 bot', kind: 'resident' },
  LofiShortsDaily: { label: 'Lofi Shorts 每日產製', kind: 'daily' },
};
const VENDOR_TASK_RE = /AMD|MicrosoftEdge|NVIDIA|OneDrive|Overwolf|ModifyLinkUpdate|Adobe|Google|Intel|Realtek/i;

// 掃描根路徑排程任務，組出「停電時本機會停擺什麼」的一行描述；失敗回 null（警報照發）
function listLocalServices() {
  try {
    const ps = `Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' } | Select-Object TaskName,State | ConvertTo-Json -Compress`;
    const out = execSync(
      'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
        Buffer.from(ps, 'utf16le').toString('base64'),
      { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const STATE = { 0: 'Unknown', 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };
    let tasks = JSON.parse(out.trim());
    if (!Array.isArray(tasks)) tasks = [tasks];
    const resident = [];
    const daily = [];
    for (const t of tasks) {
      const st = typeof t.State === 'number' ? STATE[t.State] : String(t.State);
      const known = KNOWN_TASKS[t.TaskName];
      if (known) {
        if (known.kind === 'daily') {
          if (st !== 'Disabled') daily.push(known.label);
        } else if (st === 'Running') resident.push(known.label);
      } else if (st === 'Running' && !VENDOR_TASK_RE.test(t.TaskName)) {
        resident.push(t.TaskName); // 未登錄的自訂常駐任務，以原名列出
      }
    }
    const parts = [];
    if (resident.length) parts.push(`${resident.join('、')}（常駐中，斷電即停擺）`);
    if (daily.length) parts.push(`${daily.join('、')}（停電時段排程將缺產）`);
    return parts.length ? parts.join('；') : '無常駐服務在跑';
  } catch (e) {
    log('listLocalServices failed: ' + e.message);
    return null;
  }
}

// 從公告文字抽「停電時間」與「停電區域」；抽不到的欄位回 null
function extractOutageInfo(text, title) {
  const t = String(text || '').replace(/\s+/g, ' ');
  let time = null;
  let area = null;
  let m = /停電(?:日期及)?時間[：: ]\s*([^。；;]{4,80})/.exec(t);
  if (!m) m = /((?:\d{2,3}年\s?)?\d{1,2}\/\d{1,2}[^，。；;]{0,40}?(?:起?至|[-~～][^，。；;]{0,20})[^，。；;]{0,40}?(?:止|\d{1,2}[:：]\d{2}))/.exec(t);
  if (m) time = m[1].trim();
  m = /停電(?:區域|範圍)[：: ]\s*([^。；;]{2,80})/.exec(t);
  if (m) area = m[1].trim();
  if (!area) {
    // 退而求其次：標題括號內通常就是棟舍清單，例：停電公告（研二，研三，十二舍，十三舍）
    m = /[（(]([^）)]{2,60})[）)]/.exec(String(title || ''));
    if (m && /舍|校區|館|大樓|全/.test(m[1])) area = m[1].trim();
  }
  if (!time) {
    m = /[（(]([^）)]*\d{1,2}\/\d{1,2}[^）)]*)[）)]/.exec(String(title || ''));
    if (m) time = m[1].trim();
  }
  return { time, area };
}

// view 型公告抓詳情頁內文（<div class="ed_txt">）；doc 型（純附件）回 null
async function fetchOutageDetail(item) {
  if (!/\/news\/view\?|\/data\/view\?/.test(item.url)) return null;
  try {
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = /<div class="ed_txt">([\s\S]*?)<\/div>/.exec(html);
    return m ? stripHtml(m[1]).slice(0, 3000) : null;
  } catch (e) {
    log(`outage detail fetch failed（${item.url}）: ${e.message}`);
    return null;
  }
}

// 回傳 true＝本輪有執行（state 需存檔）；false＝未到輪詢間隔
async function checkOutages(config, state) {
  const pollMs = (config.outagePollMinutes || 30) * 60 * 1000;
  const o = (state.outage = state.outage || { seen: {}, lastCheckedAt: 0 });
  if (!ONCE && Date.now() - o.lastCheckedAt < pollMs) return false;
  o.lastCheckedAt = Date.now();

  const firstRun = Object.keys(o.seen).length === 0;
  for (const source of OUTAGE_SOURCES) {
    let html;
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      log(`outage source ${source.key} fetch failed: ${e.message}`);
      continue;
    }
    const items = parseAnnouncements(html, source);
    if (!items.length) {
      log(`outage source ${source.key}: 0 筆（頁面可能改版，需人工檢查解析規則）`);
      continue;
    }
    log(`outage source ${source.key}: ${items.length} 筆（最新：${items[0].title}｜${items[0].dateText}）`);
    for (const it of items) {
      if (o.seen[it.id]) continue;
      o.seen[it.id] = Date.now();
      const rel = outageRelevance(it.title);
      if (!rel) continue;
      // 首輪只補報 14 天內的公告，避免灌歷史訊息
      if (firstRun && (!it.date || Date.now() - it.date.getTime() > 14 * 86400000)) continue;
      const tag =
        rel === 'direct' ? '🚨 **十三舍停電公告**' : '🔌 **停電公告（可能涵蓋十三舍）**';
      const detail = await fetchOutageDetail(it); // doc 型附件無內文頁，回 null
      const info = extractOutageInfo(detail, it.title);
      const services = listLocalServices();
      const lines = [
        `${tag}：${it.title}`,
        `⏰ 停電時間：${info.time || (detail ? '未能自動擷取，見公告原文' : '見公告附件')}`,
        `📍 停電區域：${info.area || '未能自動擷取，見公告原文'}`,
      ];
      if (services) lines.push(`🤖 屆時本機停擺：${services}`);
      lines.push(`-# ${it.source.name}｜發布 ${it.dateText || '?'}｜[公告原文](<${it.url}>)`);
      await webhookPost(config, { content: lines.join('\n') });
      log('outage alert sent: ' + it.title);
    }
  }

  // seen 上限 300 筆，砍最舊的（value＝首見時間戳）
  const keys = Object.keys(o.seen);
  if (keys.length > 300) {
    keys.sort((a, b) => o.seen[a] - o.seen[b]);
    for (const k of keys.slice(0, keys.length - 300)) delete o.seen[k];
  }
  return true;
}

// ===== 主流程 =====
async function tick(config) {
  const state = loadJson(STATE_PATH, {});
  postsThisTick = 0;

  // 停電線獨立 try/catch＋提前存檔：Claude API 掛掉不影響停電監控，反之亦然
  try {
    if ((await checkOutages(config, state)) && !DRY) saveState(state);
  } catch (e) {
    log('outage check error: ' + e.message);
  }
  const [status, u] = await Promise.all([
    fetchStatus(),
    fetchUsage().catch((e) => ({ data: null, note: e.message, stale: readUsageCache() })),
  ]);
  const usage = u.data; // null＝本輪無新資料：警報水位不動、儀表板沿用舊值顯示
  if (!usage) {
    const staleAt = u.stale ? new Date(u.stale.at).toISOString().slice(11, 16) + 'Z' : null;
    log(`usage 降級：${u.note}${staleAt ? `（儀表板沿用 ${staleAt} 的資料）` : '（無舊值可用）'}`);
  }

  // 警報管理：用量警報只留最新一則；新事故保留；事故更新每件只留最新一則；解決＝撤下更新警報
  const { alerts, toDelete } = collectAlerts(status, usage, state, config);
  const tryDelete = async (id, what = 'old alert') => {
    try {
      await webhookDelete(config, id);
      log(`${what} deleted: ${id}`);
    } catch (e) {
      log(`${what} cleanup failed: ${e.message}`);
    }
  };
  for (const a of alerts) {
    const msg = await webhookPost(config, { content: a.text });
    const id = msg && msg.id && msg.id !== 'dry-run' ? msg.id : null;
    if (a.type === 'usage') {
      if (state.usageAlertId) await tryDelete(state.usageAlertId);
      state.usageAlertId = id || state.usageAlertId;
    } else if (a.type === 'new') {
      const inc = state.incidents[a.incidentId];
      if (inc && id) inc.newAlertId = id; // 記住訊息 id，事故解決時撤下
    } else if (a.type === 'update') {
      const inc = state.incidents[a.incidentId];
      if (inc && inc.updateAlertId) await tryDelete(inc.updateAlertId);
      if (inc && id) inc.updateAlertId = id;
    }
    log('alert sent: ' + a.text.split('\n')[0]);
  }
  for (const id of toDelete) await tryDelete(id);

  // 儀表板：本輪沒發任何通報就原地編輯；有發通報（儀表板被擠上去了）就刪掉舊的、重發一則到頻道最底，
  // 讓用量永遠停在畫面最下方（因此儀表板訊息 id 會變，不要釘選）
  const dashboard = buildDashboard(status, usage, u);
  const bumped = postsThisTick > 0;
  let edited = false;
  if (state.dashboardMessageId && !bumped) {
    edited = await webhookEdit(config, state.dashboardMessageId, dashboard);
  }
  if (!edited) {
    if (state.dashboardMessageId && bumped) await tryDelete(state.dashboardMessageId, 'dashboard');
    const msg = await webhookPost(config, dashboard);
    if (msg && msg.id && msg.id !== 'dry-run') state.dashboardMessageId = msg.id;
    log(`dashboard message ${bumped ? 're-posted to bottom' : 'created'}: ${msg.id}`);
  }

  if (!DRY) saveState(state); // dry-run 不得留下副作用（否則會吃掉真警報的水位）
  log(
    usage
      ? `tick ok（5h ${usage.five_hour.utilization}% / 週 ${usage.seven_day.utilization}%，來源 ${u.source}，警報 ${alerts.length} 則）`
      : `tick ok（用量降級中，警報 ${alerts.length} 則）`
  );
}

async function main() {
  const config = loadJson(CONFIG_PATH, null);
  if (!config || !config.webhookUrl || config.webhookUrl.includes('PENDING')) {
    if (DRY) {
      log('dry-run：webhook 未設定，僅測試資料抓取與組裝');
      const [status, u] = await Promise.all([fetchStatus(), fetchUsage()]);
      const dashboard = buildDashboard(status, u.data, u);
      console.log(JSON.stringify(dashboard, null, 1));
      const state = loadJson(STATE_PATH, {});
      const alerts = collectAlerts(status, u.data, state, config || {});
      console.log('alerts:', JSON.stringify(alerts, null, 1));
      return;
    }
    console.error('config.json 的 webhookUrl 尚未設定，結束。');
    process.exit(1);
  }

  const pollMs = (config.pollMinutes || 5) * 60 * 1000;
  const run = () =>
    tick(config).catch((e) => log('tick error: ' + e.message));
  await run();
  if (!ONCE) setInterval(run, pollMs);
}

if (!process.env.WATCHER_NO_MAIN) main();

// 測試用出口（WATCHER_NO_MAIN=1 時可 require 本檔而不啟動輪詢）
module.exports = {
  parseAnnouncements,
  outageRelevance,
  extractOutageInfo,
  fetchOutageDetail,
  listLocalServices,
  buildDashboard,
  collectAlerts,
  fetchUsage,
  readUsageCache,
  tick,
};
