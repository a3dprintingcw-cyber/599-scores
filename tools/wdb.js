/* Fill the gaps in the FFK feed from WDBSport.

   The FFK publishes late or not at all: the women's Kopa never reached the
   feed, results take days, and it says nothing about who meets whom in the
   next knockout round. WDBSport (wdbsport.com, owner's permission given
   September 2026) enters all of that within minutes, in SportsPress, whose
   JSON is public. This step runs after build.js and before preserve.js:

   1. Games WDBSport has and data.json does not are added, id "w" + their event
      id. Same competition, date and pair as a fixture Adrian added by hand, and
      the app lets his copy step aside, so nothing shows twice.
   2. An FFK game still "sched" that WDBSport has a final score for gets that
      score, marked src:"wdb". The FFK never loses: its own result, once
      published, is what build.js writes on the next run. Referee scores from
      the server still override both in the app.
   3. The knockout draw: data.kobracket[div] = first round pairs in bracket
      slot order, which the app uses to pair rounds nobody has drawn yet.

   Kick off times are never changed, only reported: the FFK is the official
   source for when a game starts.

   Anything going wrong here (site down, format changed) leaves data.json
   exactly as build.js wrote it and exits 0, so the FFK refresh still ships. */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data.json');
const SITE = process.env.WDB_URL || 'https://www.wdbsport.com';
const SEASON = 330;                                   /* their "2026-2027" */

/* Their league id -> our competition id. A league not listed is ignored, so
   Aruba, Bonaire, futsal and youth never leak in. The 2026 league ids are
   added the day the FFK season starts and WDBSport creates them. */
const LEAGUES = {
  337: { div: 'kopakorsoufa2026', ko: true },         /* Kopa Kòrsou Knockout */
  338: { div: 'kopakorsouw2026' },                    /* Kopa Kòrsou (W)      */
  14:  { div: 'promed2026' }, 93: { div: 'promed2026' }, 106: { div: 'promed2026' }, 115: { div: 'promed2026' },
  15:  { div: 'segundad2026' }, 94: { div: 'segundad2026' }, 107: { div: 'segundad2026' }, 114: { div: 'segundad2026' },
  79:  { div: 'terserd2026' }, 180: { div: 'terserd2026' }, 181: { div: 'terserd2026' }, 174: { div: 'terserd2026' }, 111: { div: 'terserd2026' },
  86:  { div: 'femenino2026' }, 120: { div: 'femenino2026' }, 285: { div: 'femenino2026' }
};

/* Their team id -> our club id, checked by hand against both sites. Anything
   not here is matched by name below, and a team that still cannot be placed is
   reported and skipped, never guessed. */
const TEAMS = {
  351: '8738', 190: '8741', 171: '8740', 1069: '8752', 320: '8735', 7013: '12878',
  312: '8739', 7702: '12880', 318: '8749', 314: '8736', 310: '8733', 330: '8737',
  322: '8734', 334: '8751', 186: '8732', 2830: '11695',
  7361: '10095', 19357: '16995', 3238: '10098', 19360: '16996', 19353: '16994', 14740: '10099'
};

const log = (...a) => console.log('[wdb]', ...a);
const bail = m => { log(m + ', data.json left as built'); process.exit(0); };

async function get(url) {
  const r = await fetch(SITE + url, { headers: { 'user-agent': '599scores-sync (+https://599scores.com)' } });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return { json: await r.json(), pages: +r.headers.get('x-wp-totalpages') || 1 };
}
async function all(url) {
  const out = []; let page = 1, pages = 1;
  do {
    const r = await get(url + (url.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    out.push(...r.json); pages = r.pages; page++;
  } while (page <= pages && page <= 20);
  return out;
}

const plain = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&amp;/g, '&').replace(/\b(s\.?v|c\.?r\.?k\.?s\.?v|r\.?k\.?s\.?v|c\.?v\.?v|f\.?c|c\.?d|u\.?d|c\.?h|sport club)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const WOMEN = /\b(f|femenino|damas?|w|women|senior)\b/;
const bare = s => plain(s).replace(/\b(f|femenino|damas?|w|women|senior|ii)\b/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const clubs = data.clubs || [];
  const byId = {}; clubs.forEach(c => byId[c.id] = c);

  let events, venues, tours;
  try {
    events = await all('/wp-json/sportspress/v2/events?seasons=' + SEASON + '&orderby=date&order=asc');
    venues = await all('/wp-json/sportspress/v2/venues');
    tours = (await get('/wp-json/wdbsport/v1/tournaments')).json.items || [];
  } catch (e) { bail('could not read WDBSport (' + e.message + ')'); }
  if (!Array.isArray(events)) bail('unexpected events format');

  const venueName = {}; venues.forEach(v => venueName[v.id] = String(v.name || '').replace(/&amp;/g, '&'));

  /* Team names come from the event title "Home vs Away". */
  const unknown = new Set();
  function ours(wid, name, women) {
    if (TEAMS[wid]) return TEAMS[wid];
    const want = bare(name);
    const hits = clubs.filter(c => bare(c.name) === want || bare(c.short) === want)
      .filter(c => WOMEN.test(plain(c.name)) === women || /femenino|kopakorsouw/.test(c.div) === women);
    if (hits.length === 1) return hits[0].id;
    unknown.add(wid + ' ' + name);
    return null;
  }

  const matches = data.matches || (data.matches = []);
  const pairKey = (div, a, b) => div + '|' + [a, b].sort().join('|');
  const ourIdx = {};
  matches.forEach(m => { (ourIdx[pairKey(m.div, m.home, m.away)] = ourIdx[pairKey(m.div, m.home, m.away)] || []).push(m); });
  const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);

  let added = 0, scored = 0; const timeDiffs = [];
  for (const e of events) {
    const lg = (e.leagues || []).map(l => LEAGUES[l]).find(Boolean);
    if (!lg || (e.teams || []).length !== 2) continue;
    const title = String((e.title && e.title.rendered) || '').replace(/&#8211;|&amp;/g, ' ');
    const [hn, an] = title.split(/\s+vs\.?\s+/i);
    const women = lg.div.includes('kopakorsouw') || lg.div.startsWith('femenino');
    const home = ours(e.teams[0], hn, women), away = ours(e.teams[1], an, women);
    if (!home || !away) continue;

    const date = String(e.date).slice(0, 10), time = String(e.date).slice(11, 16);
    const res = e.results || {};
    const g = t => res[t] && res[t].goals !== undefined && res[t].goals !== '' ? +res[t].goals : null;
    const hs = g(e.teams[0]), as = g(e.teams[1]);
    const final = e.status === 'publish' && hs !== null && as !== null && !isNaN(hs) && !isNaN(as);

    const mine = (ourIdx[pairKey(lg.div, home, away)] || []).find(m => dayDiff(m.date, date) <= 3);
    if (mine) {
      if (mine.time && time && mine.time !== time && mine.date === date && mine.status === 'sched')
        timeDiffs.push(byId[home].short + ' v ' + byId[away].short + ' ' + date + ': FFK ' + mine.time + ', WDB ' + time);
      if (mine.status === 'sched' && final) {
        const flip = mine.home !== home;
        mine.hs = flip ? as : hs; mine.as = flip ? hs : as;
        mine.status = 'ft'; mine.src = 'wdb'; scored++;
      }
      continue;
    }
    const m = {
      id: 'w' + e.id, div: lg.div, group: '', md: 0, date, time,
      venue: venueName[(e.venues || [])[0]] || '', ref: '',
      home, away, hs: final ? hs : 0, as: final ? as : 0, status: final ? 'ft' : 'sched',
      events: [], att: 0, potm: '', officials: { ref: '', ar1: '', ar2: '', fourth: '' },
      respect: { home: 0, away: 0 }, src: 'wdb'
    };
    if (lg.ko) m.ko = true;
    matches.push(m); added++;
    (ourIdx[pairKey(lg.div, home, away)] = ourIdx[pairKey(lg.div, home, away)] || []).push(m);
  }

  /* The draw. Their tournament lists the first round slot by slot; later
     rounds follow the usual tree (slots 0+1 meet, 2+3 meet, ...). */
  data.kobracket = data.kobracket || {};
  for (const t of tours) {
    const lg = t.league && LEAGUES[t.league.id];
    if (!lg || !lg.ko || !t.season || t.season.id !== SEASON) continue;
    try {
      const full = (await get('/wp-json/wdbsport/v1/tournaments/' + t.id)).json;
      const first = (((full.bracket || {}).rounds || [])[0] || {}).slots || [];
      const pairs = first.slice().sort((a, b) => a.slot - b.slot).map(s => {
        const mm = s.match || {};
        const h = mm.home && ours(mm.home.id, mm.home.name, false), a = mm.away && ours(mm.away.id, mm.away.name, false);
        return h && a ? [h, a] : null;
      });
      if (pairs.length >= 2 && pairs.every(Boolean)) {
        data.kobracket[lg.div] = pairs;
        log('draw for ' + lg.div + ': ' + pairs.map(p => byId[p[0]].short + '/' + byId[p[1]].short).join(', '));
      } else log('draw for ' + lg.div + ' not complete yet, left as it was');
    } catch (e) { log('draw for ' + lg.div + ' unreadable (' + e.message + ')'); }
  }

  fs.writeFileSync(OUT, JSON.stringify(data));
  log('added ' + added + ' game(s), filled ' + scored + ' result(s)');
  timeDiffs.forEach(s => log('kick off differs, kept FFK: ' + s));
  unknown.forEach(s => log('no club for WDBSport team ' + s + ', skipped (add it to TEAMS)'));
})().catch(e => bail('failed: ' + e.message));
