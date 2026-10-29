// Claude Status watcher
// 整合 Claude 服務狀態（status.claude.com 公開 API）與本帳號用量（OAuth usage API），
// 以 Discord Webhook 維護一則自動更新的儀表板訊息；事故新增/更新/解決與用量跨閾值時另發警報
//（閾值 80% 起每 5% 一階，跨過各報一次）。
// 另監控 NYCU 校園停電公告（十三舍相關；總務處＋住服組兩來源，預設每 30 分鐘），有新公告即發警報。
// 無 npm 依賴（Node 18+ 全域 fetch）。用法：
//   node watcher.js          常駐，每 pollMinutes 分鐘更新一次
//   node watcher.js --once   跑一輪就結束（測試/排程用）
//   node watcher.js --dry    只印出會發送的內容，不打 Discord（測試用）
// Exit code：0 正常結束（--once/--dry）；1 未預期錯誤（start-watcher.cmd loop 會重啟）；
//   2 設定錯誤（loop 停止）；3 另一實例已在執行（loop 等 5 分鐘後重試）。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
// 其他本機發送端（ops-audit、notify-fail、lofi）送出訊息後會寫這個檔；mtime 晚於儀表板最後貼出時間＝儀表板被擠上去了
const BUMP_PATH = path.join(DIR, 'dashboard.bump');
const BUMP_CHECK_MS = 15 * 1000;
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

// 死人開關：這些日報成功時會寫 last-success（ISO 時間字串）；超過 26 小時沒更新就發告警（同一項 12 小時內只發一次）。
// 檔案不存在：從 watcher 首次看到起算（state.deadmanMissing[key]），超過 26 小時同樣告警「從未成功過」；檔案出現即清除。
const DEADMAN_FILES = [
  { key: 'e3', name: 'E3 日報', file: 'C:/Users/user/Desktop/dev/e3-course-watch/data/last-success' },
  { key: 'gmail', name: 'Gmail 日報', file: 'C:/Users/user/Desktop/dev/gmail-watch/data/last-success' },
  { key: 'lofi', name: 'Lofi 日報', file: 'C:/Users/user/Desktop/dev/youtube generator/data/last-success' },
  // 2026-10-29 起的「每日固定時刻」型（有 dailyAt）：最近一次「dailyAt＋graceMin 已過」的那一輪，檔案時間必須晚於 dailyAt 前 5 分鐘，
  // 否則告警（每一輪只告警一次）。file 可含 {date}（該輪的本機日期 YYYY-MM-DD），也可傳陣列（依序全部讀）。
  //   mtimeOnly：用檔案 mtime 當「有跑過」的證據；marker：改讀檔案內容，找符合的最新一行（行內第一個 ISO 時間戳）
  //   since：YYYY-MM-DD，之前的輪次不檢查（新功能第一輪之前不該告警）
  // lab-slack：run-daily.log 在每次 Daily 啟動（含額度失敗班、quota-gate 延後）都會被寫，所以 mtime 新＝「06:30 那班有跑」。
  //   額度失敗是預期狀態（health-check 會報 warn），不是這裡的事；這裡只抓「排程根本沒跑」。
  { key: 'labslack', name: 'lab-slack 日報', file: 'C:/Users/user/Desktop/dev/lab-slack-watch/logs/run-daily.log', dailyAt: '06:30', graceMin: 90, mtimeOnly: true },
  // plane：data/digest-state.json 只在「有發出」時才寫，沒事件的日子（skipped）不更新，拿它當死人開關會天天誤報，
  // 所以改看 bot.log 的 `digest daily (sent|skipped)`（兩種都算有跑）。bot.log 啟動時超過 5MB 會輪成 .1，兩檔都讀。
  { key: 'plane', name: 'Plane 每日摘要', file: ['C:/Users/user/Desktop/dev/plane/plane-discord-bot/bot.log.1', 'C:/Users/user/Desktop/dev/plane/plane-discord-bot/bot.log'],
    marker: /\[bot\] digest daily (sent|skipped) /, dailyAt: '07:30', graceMin: 60, since: '2026-10-30' },
  // ops-audit：health-check 無法監控自己（OpsHealth-Daily 沒跑就沒人報），由這裡檢查當天報告檔（--dry 寫的是 .dry.md，不算）
  { key: 'ophealth', name: 'OpsHealth 每日健康檢查', file: 'C:/Users/user/Desktop/dev/ops-audit/reports/health/health-{date}.md', dailyAt: '09:00', graceMin: 30, mtimeOnly: true },
];
const DEADMAN_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const DEADMAN_REALERT_MS = 12 * 60 * 60 * 1000;

// Max 方案每月附的 API credits（2026-10-10 起）：e3-course-watch／gmail-watch／plane bot 走 API 時，
// 每次呼叫把 claude -p 回報的 total_cost_usd append 一行 JSON 到這個帳本；儀表板按額度週期加總顯示。
// 只算這三支程式（Playground、其他用途不在內），所以標「本機估算」，準確值以 Console 的 Credits 為準。
// 週期：額度每月在 API_CREDIT_CYCLE_DAY 號（UTC）發放、下個月同日到期（Console Billing：granted 10/10、expires 11/10）。
const API_LEDGER_PATH = path.join(DIR, 'api-ledger.jsonl');
const API_CREDIT_TOTAL_USD = 100;
const API_CREDIT_CYCLE_DAY = 10;

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

const DEADMAN_DAILY_SLACK_MS = 5 * 60 * 1000; // 排程可能早幾秒觸發

// dailyAt 型項目：最近一次「dailyAt＋寬限已過」的輪次時刻（ms，本機時區）；since 之前或不是 dailyAt 型回 null
function deadmanDue(item, now) {
  if (!item.dailyAt) return null;
  const [h, m] = item.dailyAt.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() + (item.graceMin ?? 30) * 60000 > now) d.setDate(d.getDate() - 1);
  if (item.since) {
    const [y, mo, da] = item.since.split('-').map(Number);
    if (d.getTime() < new Date(y, mo - 1, da).getTime()) return null;
  }
  return d.getTime();
}

// 解析項目的檔案路徑清單：{date} 換成 dueMs 當天的本機日期；file 可為字串或陣列
function deadmanFiles(item, dueMs) {
  const date = new Date(dueMs).toLocaleDateString('sv-SE');
  return [].concat(item.file).map((f) => f.replaceAll('{date}', date));
}

// dailyAt 型項目「有跑過」的最新證據時間（ms）；沒有證據回 NaN。檔案讀不到（非 ENOENT）丟錯，由呼叫端略過
function deadmanDailyEvidence(item, dueMs) {
  let latest = NaN;
  for (const f of deadmanFiles(item, dueMs)) {
    let t = NaN;
    try {
      if (item.marker) {
        for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
          if (!item.marker.test(line)) continue;
          const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/.exec(line);
          const p = iso ? Date.parse(iso[1]) : NaN;
          if (Number.isFinite(p) && !(p <= t)) t = p;
        }
      } else {
        t = fs.statSync(f).mtimeMs;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (Number.isFinite(t) && !(t <= latest)) latest = t;
  }
  return latest;
}

// 死人開關：notify(content) 為注入的發送函式（測試用假函式）；回傳本輪觸發的 key 陣列。
// 內容時間＝檔案內容的 ISO 時間字串，解析失敗退回 mtime。state.deadman[key]＝上次告警時間（ms）。
// dailyAt 型項目（見 DEADMAN_FILES 註解）：每一輪（due）只告警一次——state.deadman[key] >= due 就不再發。
async function checkDeadman(state, notify, opts = {}) {
  const files = opts.files || DEADMAN_FILES;
  const now = opts.now || Date.now();
  const d = (state.deadman = state.deadman || {});
  const fired = [];
  for (const item of files) {
    if (item.dailyAt) {
      const due = deadmanDue(item, now);
      if (due == null) continue;
      let at;
      try {
        at = deadmanDailyEvidence(item, due);
      } catch (e) {
        log(`deadman: ${item.name} 讀不到（${e.code || e.message}），略過`);
        continue;
      }
      if (Number.isFinite(at) && at >= due - DEADMAN_DAILY_SLACK_MS) continue;
      if (d[item.key] && d[item.key] >= due) continue;
      const dueTxt = new Date(due).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      await notify(`⚠️ ${item.name} 沒有在預期時間完成（應在 ${dueTxt} 前後；${Number.isFinite(at) ? `最後紀錄 ${tw(new Date(at).toISOString())}` : '找不到任何紀錄'}）`);
      d[item.key] = now;
      fired.push(item.key);
      continue;
    }
    let at;
    try {
      const st = fs.statSync(item.file);
      const t = Date.parse(fs.readFileSync(item.file, 'utf8').trim());
      at = Number.isFinite(t) ? t : st.mtimeMs;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log(`deadman: ${item.name} last-success 讀不到（${e.code || e.message}），略過`);
        continue;
      }
      // 檔案不存在：從 watcher 第一次看到不存在起算，持續超過門檻就告警（沿用 12h 去重）
      const m = (state.deadmanMissing = state.deadmanMissing || {});
      if (!m[item.key]) {
        m[item.key] = now;
        log(`deadman: ${item.name} last-success 不存在，從現在起算 ${DEADMAN_MAX_AGE_MS / 3600000}h`);
        continue;
      }
      const missAge = now - m[item.key];
      if (missAge <= DEADMAN_MAX_AGE_MS) continue;
      if (d[item.key] && now - d[item.key] < DEADMAN_REALERT_MS) continue;
      log(`deadman: ${item.name} last-success 持續不存在超過 ${DEADMAN_MAX_AGE_MS / 3600000}h，告警`);
      await notify(`⚠️ ${item.name} 日報從未成功過（last-success 不存在，已觀察 ${(missAge / 3600000).toFixed(1)} 小時，超過 26 小時）`);
      d[item.key] = now;
      fired.push(item.key);
      continue;
    }
    if (state.deadmanMissing) delete state.deadmanMissing[item.key];
    const age = now - at;
    if (age <= DEADMAN_MAX_AGE_MS) continue;
    if (d[item.key] && now - d[item.key] < DEADMAN_REALERT_MS) continue;
    await notify(`⚠️ ${item.name} 日報超過 26 小時沒成功（上次成功 ${tw(new Date(at).toISOString())}，已過 ${(age / 3600000).toFixed(1)} 小時）`);
    d[item.key] = now;
    fired.push(item.key);
  }
  return fired;
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

// 目前額度週期 [start, end)（UTC），以每月 API_CREDIT_CYCLE_DAY 號 00:00 UTC 為界
function apiCreditCycle(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let start = new Date(Date.UTC(y, m, API_CREDIT_CYCLE_DAY));
  if (start > now) start = new Date(Date.UTC(y, m - 1, API_CREDIT_CYCLE_DAY));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, API_CREDIT_CYCLE_DAY));
  return { start, end };
}

// 帳本每月輪替（2026-10-29 起）：首筆月份早於本月（台北時間）就把整檔改名為 api-ledger-YYYY-MM.jsonl（YYYY-MM＝首筆所在月，
// 撞名加 -2、-3…），不刪不壓縮；寫入端（各專案 agents.js）每次 append 一行、不長期持有檔案，改名後下一次寫入自動新建。
// 額度週期是每月 10 號（UTC）而不是日曆月，所以 summarizeApiLedger 會一併讀所有輪替檔（用 ts 過濾），週期跨月時不會少算。
const LEDGER_TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const ledgerMonth = (ms) => new Date(ms + LEDGER_TAIPEI_OFFSET_MS).toISOString().slice(0, 7);

// 帳本首筆的月份（YYYY-MM，台北）；檔案不存在／空／沒有可解析的行回 null。只讀開頭 8KB
function ledgerFirstMonth(ledgerPath = API_LEDGER_PATH) {
  let fd;
  try {
    fd = fs.openSync(ledgerPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const t = new Date(JSON.parse(line).ts).getTime();
        if (Number.isFinite(t)) return ledgerMonth(t);
      } catch {
        /* 空行、壞行、被 8KB 截斷的最後一行 → 看下一行 */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 回傳 { rotated, to?, reason? }；改名失敗（例如被占用）丟錯，由呼叫端記 log、下一輪再試
function rotateApiLedger(now = new Date(), ledgerPath = API_LEDGER_PATH) {
  const first = ledgerFirstMonth(ledgerPath);
  if (!first) return { rotated: false, reason: 'empty-or-missing' };
  if (first >= ledgerMonth(now.getTime())) return { rotated: false, reason: 'current-month' };
  const base = ledgerPath.replace(/\.jsonl$/, '');
  let to = `${base}-${first}.jsonl`;
  for (let i = 2; fs.existsSync(to); i++) to = `${base}-${first}-${i}.jsonl`;
  fs.renameSync(ledgerPath, to);
  return { rotated: true, to };
}

// 現行帳本＋所有輪替檔（api-ledger-YYYY-MM[-N].jsonl）
function ledgerFiles(ledgerPath = API_LEDGER_PATH) {
  const dir = path.dirname(ledgerPath);
  const base = path.basename(ledgerPath).replace(/\.jsonl$/, '');
  const prefix = `${base}-`;
  let rotated = [];
  try {
    rotated = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}(-\d+)?\.jsonl$/.test(n.slice(prefix.length)))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    /* 目錄讀不到 → 只看現行檔 */
  }
  return [...rotated, ledgerPath];
}

// 讀帳本，回傳本週期 { usedUsd, calls, end } ；帳本不存在＝本週期 0 元（尚未有 API 呼叫），壞行略過
function summarizeApiLedger(now = new Date(), ledgerPath = API_LEDGER_PATH) {
  const { start, end } = apiCreditCycle(now);
  let usedUsd = 0;
  let calls = 0;
  let text = '';
  for (const f of ledgerFiles(ledgerPath)) {
    try {
      text += fs.readFileSync(f, 'utf8') + '\n';
    } catch {
      /* 檔案不存在或讀不到 → 略過這個檔 */
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const t = new Date(e.ts);
      if (!(t >= start && t < end)) continue;
      const c = Number(e.cost_usd);
      if (Number.isFinite(c) && c > 0) usedUsd += c;
      calls += 1;
    } catch {
      /* 壞行（例如寫到一半）略過 */
    }
  }
  return { usedUsd, calls, end };
}

// 共用 API 冷卻檔（各專案 API 失敗改走訂閱時寫入；env AUTOMATION_API_COOLDOWN 可覆寫路徑）。
// 回傳目前有效的冷卻 { until: Date, reason }，沒有／壞檔／已過期回 null。
const API_COOLDOWN_PATH = process.env.AUTOMATION_API_COOLDOWN || path.join(DIR, 'api-cooldown.json');
const COOLDOWN_REASON_TEXT = { credit: '額度用完', auth: '金鑰錯誤', rate: '速率限制' };
function readApiCooldown(now = new Date(), cooldownPath = API_COOLDOWN_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
    const until = new Date(j && j.until);
    if (Number.isFinite(until.getTime()) && until.getTime() > now.getTime()) return { until, reason: j.reason };
  } catch {
    // 沒有冷卻檔或壞檔 → 視為沒有冷卻
  }
  return null;
}

function apiCreditLine(now = new Date(), ledgerPath = API_LEDGER_PATH, cooldownPath = API_COOLDOWN_PATH) {
  const { usedUsd, calls, end } = summarizeApiLedger(now, ledgerPath);
  const pct = Math.round((usedUsd / API_CREDIT_TOTAL_USD) * 1000) / 10;
  const md = end.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
  let line = `${colorBar(pct)} API 額度 **$${usedUsd.toFixed(2)} / $${API_CREDIT_TOTAL_USD}**（${calls} 次，本機估算，${md} 重置）`;
  const cd = readApiCooldown(now, cooldownPath);
  if (cd) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(cd.until).map((x) => [x.type, x.value]),
    );
    line += `（⏸ API 暫停至 ${p.month}/${p.day} ${p.hour}:${p.minute}，原因：${COOLDOWN_REASON_TEXT[cd.reason] || '未知'}）`;
  }
  return line;
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
    fetch(STATUS_SUMMARY_URL, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(STATUS_INCIDENTS_URL, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
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
    signal: AbortSignal.timeout(15000),
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`webhook POST HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function webhookDelete(config, messageId) {
  if (DRY) {
    log('DRY delete ' + messageId);
    return;
  }
  const res = await fetch(`${config.webhookUrl}/messages/${messageId}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
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
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return false; // 訊息被刪了 → 呼叫端重發
  if (!res.ok) throw new Error(`webhook PATCH HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// bump 判斷：標記檔 mtime 晚於儀表板最後貼出時間（postedAt，ms）→ true。檔案不存在／讀不到＝false；postedAt 缺＝視為 0
function bumpNeeded(bumpPath, postedAt) {
  try {
    return fs.statSync(bumpPath).mtimeMs > (Number(postedAt) || 0);
  } catch {
    return false;
  }
}

// 貼一則新儀表板到最底，成功後才刪舊的並更新 state（POST 失敗會 throw，state 原封不動、舊 id 保留）
async function repostDashboard(config, state, dashboard) {
  const oldId = state.dashboardMessageId;
  // 在 POST 之前記時間：POST 進行中別人寫的 bump 會晚於它，下一輪 15 秒檢查會再重貼一次（最多多貼一次，不會迴圈）
  const postStartedAt = Date.now();
  const msg = await webhookPost(config, dashboard);
  const newId = msg && msg.id && msg.id !== 'dry-run' ? msg.id : null;
  if (newId) state.dashboardMessageId = newId;
  state.dashboardPostedAt = postStartedAt;
  if (oldId && (newId || DRY)) {
    try {
      await webhookDelete(config, oldId);
      log(`dashboard deleted: ${oldId}`);
    } catch (e) {
      log(`dashboard cleanup failed: ${e.message}`);
    }
  }
  return msg;
}

let lastDashboard = null; // 最近一次 tick 組好的儀表板 payload，給 15 秒 bump 檢查重發用

// 輕量檢查：不打用量 API，只比 mtime；需要 bump 就用上次內容重貼。呼叫端須持有 inFlight
async function bumpCheck(config) {
  if (!lastDashboard) return false;
  const state = loadJson(STATE_PATH, {});
  if (!state.dashboardMessageId || !bumpNeeded(BUMP_PATH, state.dashboardPostedAt)) return false;
  const msg = await repostDashboard(config, state, lastDashboard);
  if (!DRY) saveState(state);
  log(`dashboard bumped to bottom: ${msg && msg.id}`);
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
    apiCreditLine(),
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
let ledgerRotatedOn = null; // 本 process 已成功檢查過帳本輪替的本機日期（啟動後第一次 tick、之後每天第一次 tick 各做一次）
async function tick(config) {
  const state = loadJson(STATE_PATH, {});
  postsThisTick = 0;

  // 帳本每月輪替（--dry 不動檔案，避免測試留下副作用）
  const todayLocal = new Date().toLocaleDateString('sv-SE');
  if (!DRY && ledgerRotatedOn !== todayLocal) {
    try {
      const r = rotateApiLedger();
      if (r.rotated) log(`api-ledger rotated -> ${path.basename(r.to)}`);
      ledgerRotatedOn = todayLocal;
    } catch (e) {
      log('api-ledger rotate error: ' + e.message); // 不標記，下一輪 tick 再試
    }
  }

  // 停電線獨立 try/catch＋提前存檔：Claude API 掛掉不影響停電監控，反之亦然
  try {
    if ((await checkOutages(config, state)) && !DRY) saveState(state);
  } catch (e) {
    log('outage check error: ' + e.message);
  }
  // 死人開關獨立 try/catch＋提前存檔（同停電線）
  try {
    const fired = await checkDeadman(state, (content) => webhookPost(config, { content }));
    // 每次都存：deadmanMissing 的起算時間不能因後面 fetchStatus 失敗中斷 tick 而遺失
    if (!DRY) saveState(state);
  } catch (e) {
    log('deadman check error: ' + e.message);
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
  lastDashboard = dashboard;
  const bumped = postsThisTick > 0 || bumpNeeded(BUMP_PATH, state.dashboardPostedAt);
  let edited = false;
  if (state.dashboardMessageId && !bumped) {
    edited = await webhookEdit(config, state.dashboardMessageId, dashboard);
  }
  if (!edited) {
    const msg = await repostDashboard(config, state, dashboard);
    log(`dashboard message ${bumped ? 're-posted to bottom' : 'created'}: ${msg.id}`);
  }

  if (!DRY) saveState(state); // dry-run 不得留下副作用（否則會吃掉真警報的水位）
  log(
    usage
      ? `tick ok（5h ${usage.five_hour.utilization}% / 週 ${usage.seven_day.utilization}%，來源 ${u.source}，警報 ${alerts.length} 則）`
      : `tick ok（用量降級中，警報 ${alerts.length} 則）`
  );
}

const LOCK_PATH = path.join(__dirname, 'watcher.lock');
// 回傳 true = 拿到鎖；false = 另一個實例還活著（lock 內的 PID 存在）
// 兩實例同時競爭時，openSync 'wx' 的 EEXIST 會 throw，由呼叫端視為拿不到鎖
function acquireLock(lockPath = LOCK_PATH) {
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } // 還活著
      catch { /* 殘鎖 */ }
    }
    try { fs.unlinkSync(lockPath); } catch {}
    log(`stale lock removed (pid ${pid})`);
  }
  const fd = fs.openSync(lockPath, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  const release = () => { try { if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return true;
}

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason))); // 不 exit，讓單一 promise 失敗不拖垮 watcher
});
process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000).unref(); // 給 log flush 的時間，然後交給 loop 重啟
});

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
    console.error('config.json 的 webhookUrl 尚未設定，結束（exit 2，loop 不會重啟）。');
    process.exit(2);
  }

  if (!ONCE) {
    let got = false;
    try { got = acquireLock(); } catch (e) { got = false; } // EEXIST 競爭也視為拿不到
    if (!got) {
      log('another instance is running (see watcher.lock), exit 3');
      process.exit(3);
    }
  }

  const pollMs = (config.pollMinutes || 5) * 60 * 1000;
  let inFlight = false; // tick 與 bump 檢查共用，不可同時執行
  const run = async () => {
    if (inFlight) { log('tick skipped: previous tick still running'); return; }
    inFlight = true;
    try { await tick(config); }
    catch (e) { log('tick error: ' + e.message); }
    finally { inFlight = false; }
  };
  await run();
  if (!ONCE) {
    setInterval(run, pollMs);
    setInterval(async () => {
      if (inFlight) return; // tick 進行中就跳過，下一個 15 秒再看
      inFlight = true;
      try { await bumpCheck(config); }
      catch (e) { log('bump check error: ' + e.message); }
      finally { inFlight = false; }
    }, BUMP_CHECK_MS);
  }
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
  apiCreditCycle,
  summarizeApiLedger,
  ledgerMonth,
  ledgerFirstMonth,
  rotateApiLedger,
  ledgerFiles,
  deadmanDue,
  deadmanFiles,
  DEADMAN_FILES,
  apiCreditLine,
  readApiCooldown,
  bumpNeeded,
  repostDashboard,
  collectAlerts,
  fetchUsage,
  readUsageCache,
  checkDeadman,
  tick,
  acquireLock,
  LOCK_PATH,
};
