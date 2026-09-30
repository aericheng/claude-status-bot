// bumpNeeded 最小測試：標記檔 mtime 晚於／早於／不存在，不連網、不發 Discord。
process.env.WATCHER_NO_MAIN = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { bumpNeeded } = require('../watcher.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
const f = path.join(dir, 'dashboard.bump');
const now = Date.now();
try {
  assert.strictEqual(bumpNeeded(f, now), false, '檔案不存在 → false');
  fs.writeFileSync(f, new Date().toISOString());
  fs.utimesSync(f, new Date(now), new Date(now));
  assert.strictEqual(bumpNeeded(f, now - 60e3), true, 'mtime 晚於 postedAt → true');
  assert.strictEqual(bumpNeeded(f, now + 60e3), false, 'mtime 早於 postedAt → false');
  assert.strictEqual(bumpNeeded(f, undefined), true, 'postedAt 缺 → 視為 0');
  console.log('selftest-bump OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
