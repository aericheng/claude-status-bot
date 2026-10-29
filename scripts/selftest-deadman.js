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
  // ===== dailyAt 型（2026-10-29）：樣板路徑、mtimeOnly、marker、since、每輪只告警一次 =====
  const { deadmanDue, deadmanFiles, DEADMAN_FILES, ledgerMonth, ledgerFirstMonth, rotateApiLedger, ledgerFiles, summarizeApiLedger } = require('../watcher.js');
  const at = (y, mo, da, h, mi) => new Date(y, mo - 1, da, h, mi, 0).getTime();
  const wd = { key: 'w', name: 'W', file: path.join(dir, 'rep-{date}.md'), dailyAt: '09:00', graceMin: 30, mtimeOnly: true };
  // 輪次：09:20 還在寬限內 → 退回昨天 09:00；09:31 → 今天 09:00
  assert.strictEqual(deadmanDue(wd, at(2026, 10, 29, 9, 20)), at(2026, 10, 28, 9, 0));
  assert.strictEqual(deadmanDue(wd, at(2026, 10, 29, 9, 31)), at(2026, 10, 29, 9, 0));
  assert.strictEqual(deadmanDue({ ...wd, since: '2026-10-30' }, at(2026, 10, 29, 18, 0)), null, 'since 之前不檢查');
  assert.strictEqual(deadmanDue({ key: 'x', file: 'f' }, Date.now()), null, '非 dailyAt 型回 null');
  assert.deepStrictEqual(deadmanFiles(wd, at(2026, 10, 29, 9, 0)), [path.join(dir, 'rep-2026-10-29.md')]);
  // 檔案不存在 → 09:31 告警一次；同一輪再 tick 不重發；隔天沒檔案 → 新一輪再發
  const sd = [];
  const nd = async (c) => { sd.push(c); };
  const stD = {};
  let f2 = await checkDeadman(stD, nd, { files: [wd], now: at(2026, 10, 29, 9, 31) });
  assert.deepStrictEqual(f2, ['w']);
  assert(sd[0].includes('W') && sd[0].includes('預期時間'));
  f2 = await checkDeadman(stD, nd, { files: [wd], now: at(2026, 10, 29, 12, 0) });
  assert.deepStrictEqual(f2, [], '同一輪不重複告警');
  f2 = await checkDeadman(stD, nd, { files: [wd], now: at(2026, 10, 30, 9, 31) });
  assert.deepStrictEqual(f2, ['w'], '新一輪應再告警');
  // 檔案出現且 mtime 夠新 → 不告警（mtime 設成 09:02）
  const rep = path.join(dir, 'rep-2026-10-31.md');
  fs.writeFileSync(rep, 'x');
  fs.utimesSync(rep, new Date(at(2026, 10, 31, 9, 2)), new Date(at(2026, 10, 31, 9, 2)));
  f2 = await checkDeadman({}, nd, { files: [wd], now: at(2026, 10, 31, 9, 40) });
  assert.deepStrictEqual(f2, []);
  // mtime 早於輪次前 5 分鐘以上 → 告警
  fs.utimesSync(rep, new Date(at(2026, 10, 31, 8, 40)), new Date(at(2026, 10, 31, 8, 40)));
  f2 = await checkDeadman({}, nd, { files: [wd], now: at(2026, 10, 31, 9, 40) });
  assert.deepStrictEqual(f2, ['w']);
  // marker 型：log 內 sent／skipped 行（first ISO）算證據，missed 行不算
  const botlog = path.join(dir, 'bot.log');
  const wm = { key: 'p', name: 'P', file: [path.join(dir, 'bot.log.1'), botlog], marker: /\[bot\] digest daily (sent|skipped) /, dailyAt: '07:30', graceMin: 60 };
  fs.writeFileSync(botlog, '[bot] digest daily missed date=2026-11-01 reason=after-12:00\n');
  f2 = await checkDeadman({}, nd, { files: [wm], now: at(2026, 11, 1, 8, 40) });
  assert.deepStrictEqual(f2, ['p'], 'missed 行不算證據');
  fs.writeFileSync(botlog, `[bot] digest daily skipped date=2026-11-01 reason=empty at=${new Date(at(2026, 11, 1, 7, 30)).toISOString()}\n`);
  f2 = await checkDeadman({}, nd, { files: [wm], now: at(2026, 11, 1, 8, 40) });
  assert.deepStrictEqual(f2, [], 'skipped 行算證據');
  // 實際設定的三個新項都在，且 file 樣板欄位齊全
  const keys = DEADMAN_FILES.map((x) => x.key);
  for (const k of ['labslack', 'plane', 'ophealth']) assert(keys.includes(k), 'DEADMAN_FILES 缺 ' + k);
  assert(DEADMAN_FILES.find((x) => x.key === 'ophealth').file.includes('{date}'));

  // ===== api-ledger 每月輪替（2026-10-29）=====
  assert.strictEqual(ledgerMonth(Date.parse('2026-10-31T17:00:00Z')), '2026-11', '台北時間跨月');
  const led = path.join(dir, 'api-ledger.jsonl');
  const row = (ts, c) => JSON.stringify({ ts, project: 'p', label: 'l', ok: true, cost_usd: c }) + '\n';
  assert.deepStrictEqual(rotateApiLedger(new Date('2026-11-01T01:00:00Z'), led), { rotated: false, reason: 'empty-or-missing' });
  fs.writeFileSync(led, row('2026-10-11T00:00:00Z', 1) + row('2026-10-28T00:00:00Z', 2) + row('2026-10-30T00:00:00Z', 4));
  assert.strictEqual(ledgerFirstMonth(led), '2026-10');
  assert.deepStrictEqual(rotateApiLedger(new Date('2026-10-30T01:00:00Z'), led), { rotated: false, reason: 'current-month' });
  assert(fs.existsSync(led), '同月不改名');
  const r1 = rotateApiLedger(new Date('2026-11-01T01:00:00Z'), led);
  assert.strictEqual(r1.rotated, true);
  assert.strictEqual(path.basename(r1.to), 'api-ledger-2026-10.jsonl');
  assert(!fs.existsSync(led) && fs.existsSync(r1.to));
  // 輪替後新寫入的檔仍被加總：週期 10/10–11/10，兩個檔的 10 月與 11 月筆數都要算
  fs.writeFileSync(led, row('2026-11-02T00:00:00Z', 8));
  const sum = summarizeApiLedger(new Date('2026-11-03T00:00:00Z'), led);
  assert.strictEqual(sum.calls, 4);
  assert(Math.abs(sum.usedUsd - 15) < 1e-9, 'usedUsd=' + sum.usedUsd);
  assert.strictEqual(ledgerFiles(led).length, 2);
  // 已有同名輪替檔時加 -2，不覆蓋
  fs.writeFileSync(led, row('2026-10-05T00:00:00Z', 1));
  const r2 = rotateApiLedger(new Date('2026-11-01T01:00:00Z'), led);
  assert.strictEqual(path.basename(r2.to), 'api-ledger-2026-10-2.jsonl');
  assert(fs.existsSync(r1.to), '舊輪替檔還在');

  fs.rmSync(dir, { recursive: true });
  console.log('selftest-deadman OK (sent=' + sent.length + ')');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
