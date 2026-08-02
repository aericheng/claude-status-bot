// Claude Status watcher
// 整合 Claude 服務狀態（status.claude.com 公開 API）與本帳號用量（OAuth usage API），
// 以 Discord Webhook 維護一則自動更新的儀表板訊息；事故新增/更新/解決與用量跨閾值時另發警報
//（閾值 80% 起每 5% 一階，跨過各報一次）。
// 無 npm 依賴（Node 18+ 全域 fetch）。用法：
//   node watcher.js          常駐，每 pollMinutes 分鐘更新一次
//   node watcher.js --once   跑一輪就結束（測試/排程用）
//   node watcher.js --dry    只印出會發送的內容，不打 Discord（測試用）

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const CREDENTIALS_PATH = 'C:/Users/user/.claude/.credentials.json';

const STATUS_SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';
const STATUS_INCIDENTS_URL = 'https://status.claude.com/api/v2/incidents.json';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const AVATAR_URL =
  'https://dka575ofm4ao0.cloudfront.net/pages-email_logos/original/362807/NEW_claude_status_email.png-d88779a1-c7b3-456d-b84e-1d0cdd4614e9.png';

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

// ===== 資料抓取 =====
async function fetchStatus() {
  const [summary, incidents] = await Promise.all([
    fetch(STATUS_SUMMARY_URL).then((r) => r.json()),
    fetch(STATUS_INCIDENTS_URL).then((r) => r.json()),
  ]);
  return { summary, incidents: incidents.incidents || [] };
}

async function fetchUsage() {
  // token 由 Claude Code 自動輪替，每次都重讀檔案
  const cred = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const token = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  if (!token) throw new Error('credentials 檔內找不到 claudeAiOauth.accessToken');
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
  return res.json();
}

// ===== Discord webhook =====
async function webhookPost(config, payload) {
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
function buildDashboard(status, usage) {
  const ind = (status.summary.status && status.summary.status.indicator) || 'none';
  const active = status.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');

  const color = ind === 'critical' || ind === 'major' ? 0xed4245 : ind === 'minor' ? 0xfee75c : 0x57f287;

  const hhmm = (iso) =>
    new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  const scoped = (usage.limits || []).filter((l) => l.kind === 'weekly_scoped' && l.scope && l.scope.model);

  const lines = [
    `${colorBar(usage.five_hour.utilization)} 5h **${usage.five_hour.utilization}%**（${hhmm(usage.five_hour.resets_at)} 重置）`,
    `${colorBar(usage.seven_day.utilization)} 週 **${usage.seven_day.utilization}%**`,
    ...scoped.map((l) => `${colorBar(l.percent)} ${l.scope.model.display_name} **${l.percent}%**`),
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
// 規則：新事故通知保留；每件事故的更新警報只留最新一則；事故解決＝撤下其更新警報、不另發訊息。
const LINK_FOOTER = '\n-# [status.claude.com](<https://status.claude.com>)';

function collectAlerts(status, usage, state, config) {
  const alerts = [];
  const toDelete = [];
  const tracked = state.incidents || {};
  const nowTracked = {};

  for (const i of status.incidents.slice(0, 30)) {
    const latest = (i.incident_updates || [])[0];
    const latestAt = latest ? latest.created_at : i.created_at;
    const prev = tracked[i.id];
    const isActive = i.status !== 'resolved' && i.status !== 'postmortem';

    if (isActive) {
      nowTracked[i.id] = { latestAt, status: i.status, updateAlertId: prev && prev.updateAlertId };
      if (!prev) {
        alerts.push({
          type: 'new',
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
      if (prev.updateAlertId) toDelete.push(prev.updateAlertId); // 解決：撤下更新警報，不發解決訊息
    }
  }
  state.incidents = nowTracked;

  // 用量閾值（跨過才報一次；視窗重置後歸零）
  const thresholds = config.usageThresholds || [80, 85, 90, 95, 100];
  state.usage = state.usage || {};
  const metrics = [
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

// ===== 主流程 =====
async function tick(config) {
  const state = loadJson(STATE_PATH, {});
  const [status, usage] = await Promise.all([fetchStatus(), fetchUsage()]);

  // 儀表板：編輯既有訊息，不存在就重發
  const dashboard = buildDashboard(status, usage);
  let edited = false;
  if (state.dashboardMessageId) {
    edited = await webhookEdit(config, state.dashboardMessageId, dashboard);
  }
  if (!edited) {
    const msg = await webhookPost(config, dashboard);
    state.dashboardMessageId = msg.id;
    log(`dashboard message created: ${msg.id}（建議在 Discord 把這則訊息釘選）`);
  }

  // 警報管理：用量警報只留最新一則；新事故保留；事故更新每件只留最新一則；解決＝撤下更新警報
  const { alerts, toDelete } = collectAlerts(status, usage, state, config);
  const tryDelete = async (id) => {
    try {
      await webhookDelete(config, id);
      log('old alert deleted: ' + id);
    } catch (e) {
      log('alert cleanup failed: ' + e.message);
    }
  };
  for (const a of alerts) {
    const msg = await webhookPost(config, { content: a.text });
    const id = msg && msg.id && msg.id !== 'dry-run' ? msg.id : null;
    if (a.type === 'usage') {
      if (state.usageAlertId) await tryDelete(state.usageAlertId);
      state.usageAlertId = id || state.usageAlertId;
    } else if (a.type === 'update') {
      const inc = state.incidents[a.incidentId];
      if (inc && inc.updateAlertId) await tryDelete(inc.updateAlertId);
      if (inc && id) inc.updateAlertId = id;
    }
    log('alert sent: ' + a.text.split('\n')[0]);
  }
  for (const id of toDelete) await tryDelete(id);

  if (!DRY) saveState(state); // dry-run 不得留下副作用（否則會吃掉真警報的水位）
  log(`tick ok（5h ${usage.five_hour.utilization}% / 週 ${usage.seven_day.utilization}%，警報 ${alerts.length} 則）`);
}

async function main() {
  const config = loadJson(CONFIG_PATH, null);
  if (!config || !config.webhookUrl || config.webhookUrl.includes('PENDING')) {
    if (DRY) {
      log('dry-run：webhook 未設定，僅測試資料抓取與組裝');
      const [status, usage] = await Promise.all([fetchStatus(), fetchUsage()]);
      const dashboard = buildDashboard(status, usage);
      console.log(JSON.stringify(dashboard, null, 1));
      const state = loadJson(STATE_PATH, {});
      const alerts = collectAlerts(status, usage, state, config || {});
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

main();
