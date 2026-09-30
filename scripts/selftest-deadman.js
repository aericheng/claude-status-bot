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
  // ENOENT：從首次看到起算。未滿 26h 不告警；超過告警一次、重複 tick 不重複；檔案出現後清除
  const gone = path.join(dir, 'gone');
  const gf = [{ key: 'gone', name: 'GONE', file: gone }];
  const sent2 = [];
  const n2 = async (c) => { sent2.push(c); };
  const st2 = {};
  fired = await checkDeadman(st2, n2, { files: gf, now });
  assert.deepStrictEqual(fired, [], '首次看到不存在不告警');
  assert.strictEqual(st2.deadmanMissing.gone, now);
  fired = await checkDeadman(st2, n2, { files: gf, now: now + 25 * 3600e3 });
  assert.deepStrictEqual(fired, [], '未滿 26h 不告警');
  fired = await checkDeadman(st2, n2, { files: gf, now: now + 26 * 3600e3 + 1000 });
  assert.deepStrictEqual(fired, ['gone'], '超過 26h 告警');
  assert(sent2[0].includes('從未成功過') && sent2[0].includes('last-success 不存在'));
  fired = await checkDeadman(st2, n2, { files: gf, now: now + 26 * 3600e3 + 5 * 60e3 });
  assert.deepStrictEqual(fired, [], '重複 tick 不重複告警');
  assert.strictEqual(sent2.length, 1);
  fs.writeFileSync(gone, new Date(now).toISOString());
  fired = await checkDeadman(st2, n2, { files: gf, now: now + 27 * 3600e3 });
  assert.deepStrictEqual(fired, []);
  assert.strictEqual(st2.deadmanMissing.gone, undefined, '檔案出現後 missing 狀態清除');
  fs.rmSync(dir, { recursive: true });
  console.log('selftest-deadman OK (sent=' + sent.length + ')');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
