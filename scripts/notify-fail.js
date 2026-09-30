// Sends a failure alert to the Discord webhook. Never fails the caller: errors go to stderr, exit 0.
// NOTIFY_DRY=1 prints the payload instead of calling fetch.
const path = require('path');

(async () => {
  try {
    const content = '\u26A0\uFE0F claude-status watcher: ' + process.argv.slice(2).join(' ');
    if (process.env.NOTIFY_DRY === '1') {
      console.log('NOTIFY_DRY would post: ' + content);
      return;
    }
    const config = require(path.join(__dirname, '..', 'config.json'));
    if (!config.webhookUrl) throw new Error('webhookUrl missing');
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error('notify-fail: HTTP ' + res.status);
    else {
      // 通知 watcher：儀表板被擠上去了，請重貼到最底。寫檔失敗不影響呼叫端
      try { require('fs').writeFileSync(path.join(__dirname, '..', 'dashboard.bump'), new Date().toISOString()); } catch {}
    }
  } catch (e) {
    console.error('notify-fail: ' + e.message);
  }
})();
