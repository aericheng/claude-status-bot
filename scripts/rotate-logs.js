'use strict';
// Shared log rotation helper (same file copied into each project's scripts/).
// Usage: node rotate-logs.js [--max-mb N] [--keep N] [--prune DIR:DAYS[:EXT]]... FILE...
//  - FILE larger than N MB (default 5) is renamed FILE.1; older .1..(keep-1) shift up, FILE.<keep> is dropped (keep default 5).
//  - --prune DIR:DAYS[:EXT] deletes regular files in DIR (non-recursive) older than DAYS days by mtime,
//    optionally only those ending in EXT (e.g. .log). Rotated names (.1-.5) are covered by the same rule.
// Must run while no process holds FILE open (call it before the writer starts). Never throws; exit code 0.
const fs = require('fs');
const path = require('path');

function rotateFile(file, maxBytes, keep) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile() || st.size <= maxBytes) return false;
  try {
    try { fs.unlinkSync(`${file}.${keep}`); } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch (e) {
    console.error(`[rotate-logs] ${file}: ${e.message}`);
    return false;
  }
}

function pruneDir(dir, days, ext, now) {
  let n = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const cutoff = now - days * 86400000;
  for (const name of names) {
    if (ext && !name.endsWith(ext) && !/\.\d+$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); n++; }
    } catch {}
  }
  return n;
}

function main(argv) {
  let maxMb = 5, keep = 5;
  const files = [], prunes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-mb') maxMb = Number(argv[++i]);
    else if (a === '--keep') keep = Number(argv[++i]);
    else if (a === '--prune') prunes.push(argv[++i]);
    else files.push(a);
  }
  if (!(maxMb > 0) || !(keep >= 1)) { console.error('[rotate-logs] bad --max-mb/--keep'); return; }
  for (const f of files) {
    if (rotateFile(f, maxMb * 1024 * 1024, keep)) console.log(`[rotate-logs] rotated ${f}`);
  }
  const now = Date.now();
  for (const spec of prunes) {
    const m = /^(.*):(\d+)(?::(\.\w+))?$/.exec(spec || '');
    if (!m) { console.error(`[rotate-logs] bad --prune ${spec}`); continue; }
    const n = pruneDir(m[1], Number(m[2]), m[3] || '', now);
    if (n) console.log(`[rotate-logs] pruned ${n} file(s) older than ${m[2]}d in ${m[1]}`);
  }
}

module.exports = { rotateFile, pruneDir };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`[rotate-logs] ${e.message}`); }
}
