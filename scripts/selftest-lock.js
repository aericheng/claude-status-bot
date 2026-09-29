process.env.WATCHER_NO_MAIN = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { acquireLock } = require('../watcher.js');

const tmp1 = path.join(os.tmpdir(), `claude-status-selftest-${process.pid}.lock`);
const tmp2 = path.join(os.tmpdir(), `claude-status-selftest-${process.pid}-b.lock`);
let child;
function cleanup() {
  try { fs.unlinkSync(tmp1); } catch {}
  try { fs.unlinkSync(tmp2); } catch {}
  if (child) child.kill();
}
function fail(m) { console.error('FAIL: ' + m); cleanup(); process.exit(1); }

fs.writeFileSync(tmp1, '999999');
if (acquireLock(tmp1) !== true) fail('stale lock should be acquired');
if (fs.readFileSync(tmp1, 'utf8').trim() !== String(process.pid)) fail('lock should hold own pid');

child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
fs.writeFileSync(tmp2, String(child.pid));
if (acquireLock(tmp2) !== false) fail('live pid lock should be refused');

cleanup();
console.log('selftest-lock OK');
