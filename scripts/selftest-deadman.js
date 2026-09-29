// checkDeadman 最小測試：暫存目錄假 last-success（27h 前／1h 前／不存在），假 notify，不發 Discord。
process.env.WATCHER_NO_MAIN = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { checkDeadman } = require('../watcher.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadman-'));
  const now = Date.now();
  const old = path.join(dir, 'old'), fresh = path.join(dir, 'fresh'), missing = path.join(dir, 'missing');
  fs.writeFileSync(old, new Date(now - 27 * 3600e3).toISOString());
  fs.writeFileSync(fresh, new Date(now - 1 * 3600e3).toISOString());
  const files = [
    { key: 'old', name: 'OLD', file: old },
    { key: 'fresh', name: 'FRESH', file: fresh },
    { key: 'missing', name: 'MISSING', file: missing },
  ];
  const sent = [];
  const notify = async (c) => { sent.push(c); };
  const state = {};
  let fired = await checkDeadman(state, notify, { files, now });
  assert.deepStrictEqual(fired, ['old']);
  assert.strictEqual(sent.length, 1);
  assert(sent[0].includes('OLD') && sent[0].includes('26 小時'));
  fired = await checkDeadman(state, notify, { files, now: now + 5 * 60e3 });
  assert.deepStrictEqual(fired, [], '12h 內重複應被擋');
  assert.strictEqual(sent.length, 1);
  fired = await checkDeadman(state, notify, { files, now: now + 12 * 3600e3 + 1000 });
  assert.deepStrictEqual(fired, ['old'], '滿 12h 應再發');
  // 內容不是 ISO 時退回 mtime
  fs.writeFileSync(fresh, 'garbage');
  fired = await checkDeadman({}, notify, { files: [files[1]], now });
  assert.deepStrictEqual(fired, []);
  fs.rmSync(dir, { recursive: true });
  console.log('selftest-deadman OK (sent=' + sent.length + ')');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
