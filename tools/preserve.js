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

/* A restored table is useless on its own. The app lists a competition's phases
   from divisions[].groups, and build.js only fills that in while it is reading
   standings it actually scraped. Put the phase list back alongside the table,
   or the standings screen has data it cannot show. */
const prevDiv = {};
(prev.divisions || []).forEach(x => { prevDiv[x.id] = x; });
(now.divisions || []).forEach(x => {
  const had = prevDiv[x.id];
  if (had && (had.groups || []).length && !(x.groups || []).length) {
    x.groups = had.groups;
    kept.push('groups/' + x.id);
  }
});

/* The whole match list. On 24 September 2026 the feed changed its schedule
   pages, the scraper found nothing, and the app went out with zero games. If a
   run comes back with far fewer matches than the last good one, keep the old list
   and let the job fail loudly instead of publishing an empty app. */
const nPrev = (prev.matches || []).length, nNow = (now.matches || []).length;
if (nPrev >= 20 && nNow < nPrev * 0.7) {
  now.matches = prev.matches;
  kept.push('matches (' + nNow + ' scraped vs ' + nPrev + ' before)');
  process.exitCode = 1;
}

/* What tools/wdb.js adds. If WDBSport could not be reached this run, build.js
   has written a file without the games only they list and without the knockout
   draw; carry the last good ones over rather than letting them vanish. A game
   the FFK has since published under the same pair and date is left out, the
   same way the app would let it step aside. */
/* Any game taken from WDBSport that this run did not produce again (their
   site was down, or it belongs to a finished season the sync no longer reads)
   is carried over, unless the FFK now has the same pair on the same day. */
{
  const key = m => m.div + '|' + m.date + '|' + [m.home, m.away].sort().join('|');
  const have = new Set((now.matches || []).map(key));
  const ids = new Set((now.matches || []).map(m => m.id));
  const back = (prev.matches || []).filter(m => /^w/.test(m.id) && m.src === 'wdb' && !ids.has(m.id) && !have.has(key(m)));
  if (back.length) { now.matches = (now.matches || []).concat(back); kept.push(back.length + ' WDBSport game(s)'); }
}
/* Phases the FFK never published (the 2025/26 Kaya 4 and finals) were added by
   hand. The feed rebuilds each competition's tables and phase list from what it
   knows, so put back any phase it left out, with its place in the phase list. */
Object.keys(prev.tables || {}).forEach(id => {
  const pt = prev.tables[id], nt = now.tables[id];
  if (!pt || !nt) return;
  Object.keys(pt).forEach(g => {
    if (!nt[g] && (pt[g] || []).length) { nt[g] = pt[g]; kept.push('phase ' + id + '/' + g); }
  });
});
(now.divisions || []).forEach(x => {
  const had = prevDiv[x.id];
  if (!had) return;
  (had.groups || []).forEach(g => {
    if (!(x.groups || []).some(y => y[0] === g[0]) && now.tables[x.id] && now.tables[x.id][g[0]]) (x.groups = x.groups || []).push(g);
  });
});
if (!now.kobracket && prev.kobracket) { now.kobracket = prev.kobracket; kept.push('kobracket'); }
/* Open fixtures (semis, finals whose teams are not known yet) are entered by
   hand into data.json; no scrape produces them, so every run carries them over. */
if (!now.openties && prev.openties) { now.openties = prev.openties; kept.push('openties'); }

/* The app reads its server address from here too. Losing it would quietly turn
   off live scores, referee sign in and the fan ladder. */
if (!now.api && prev.api) { now.api = prev.api; kept.push('api'); }
if (!now.googleClientId && prev.googleClientId) { now.googleClientId = prev.googleClientId; kept.push('googleClientId'); }

if (kept.length) {
  fs.writeFileSync(OUT, JSON.stringify(now));
  console.log('[preserve] the new scrape came back empty for ' + kept.length +
              ' item(s), kept the previous: ' + kept.join(', '));
} else {
  console.log('[preserve] the new scrape was complete, nothing to restore');
}
