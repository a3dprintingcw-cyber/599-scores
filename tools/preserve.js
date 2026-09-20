/* Keep good data when a scrape comes back thin.

   The FFK pages sometimes return without the scorer charts or without a
   standings table. build.js will happily write that empty result straight over
   a good one, and the app loses its top scorers until somebody notices. This
   step compares what was just built against the copy still in git and puts the
   older chart back wherever the new run produced nothing. A genuinely empty
   competition stays empty, because we only ever restore something that used to
   have content. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data.json');

const now = JSON.parse(fs.readFileSync(OUT, 'utf8'));

let prev = null;
try {
  prev = JSON.parse(
    execFileSync('git', ['show', 'HEAD:data.json'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString()
  );
} catch (e) {
  console.log('[preserve] no previous data.json in git, nothing to compare against');
  process.exit(0);
}

const nonEmpty = o => !!o && Object.keys(o).some(k =>
  Array.isArray(o[k]) ? o[k].length : (o[k] && typeof o[k] === 'object' && Object.keys(o[k]).length));

const kept = [];

now.leaders = now.leaders || {};
Object.keys(prev.leaders || {}).forEach(id => {
  if (!nonEmpty(now.leaders[id]) && nonEmpty(prev.leaders[id])) {
    now.leaders[id] = prev.leaders[id];
    kept.push('leaders/' + id);
  }
});

now.tables = now.tables || {};
Object.keys(prev.tables || {}).forEach(id => {
  if (!nonEmpty(now.tables[id]) && nonEmpty(prev.tables[id])) {
    now.tables[id] = prev.tables[id];
    kept.push('tables/' + id);
  }
});

/* The app reads its server address from here too. Losing it would quietly turn
   off live scores, referee sign in and the fan ladder. */
if (!now.api && prev.api) { now.api = prev.api; kept.push('api'); }

if (kept.length) {
  fs.writeFileSync(OUT, JSON.stringify(now));
  console.log('[preserve] the new scrape came back empty for ' + kept.length +
              ' item(s), kept the previous: ' + kept.join(', '));
} else {
  console.log('[preserve] the new scrape was complete, nothing to restore');
}
