/* raw.json (scraped) + editorial.json (your own content) -> ../data.json for the app. */
const fs = require('fs');
const path = require('path');
const RAW = path.join(__dirname, 'raw.json');
const OUT = path.join(__dirname, '..', 'data.json');
const EDIT = path.join(__dirname, 'editorial.json');
const log = (...a) => console.log('[build]', ...a);

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));

/* Editorial content the FFK does not publish. Kept across updates. */
const editorial = fs.existsSync(EDIT) ? JSON.parse(fs.readFileSync(EDIT, 'utf8')) : {};

/* Fallback colours for clubs with no badge, so generated crests stay distinct. */
const PALETTE = ['#1B4FD8','#C8102E','#0E7A46','#E8B60A','#6B3FA0','#E2711D','#1F7A8C','#B01B2E','#2A3C8F','#7A1F4F','#0E3A6B','#B33A1A','#5A3B8C','#146B8C','#8C6B1F','#2B2B2B'];
const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

const stripSuffix = n => n.replace(/\s+(Terser|Segunda|Femenino)$/i, '');
function abbrev(name) {
  const clean = name.replace(/^(C\.?R\.?K\.?S\.?V\.?|R\.?K\.?S\.?V\.?|S\.?V\.?|F\.?C\.?|C\.?D\.?|U\.?D\.?|C\.?V\.?V\.?|C\.?V\.?C\.?|S\.?C\.?|C\.?H\.?|C\.?S\.?D\.?)\s+/i, '').trim();
  const words = clean.split(/\s+/).filter(w => w.length > 1);
  if (words.length >= 2) return (words[0][0] + words[1][0] + (words[2] ? words[2][0] : words[0][1] || '')).toUpperCase().slice(0, 3);
  return clean.slice(0, 3).toUpperCase();
}

/* ---- clubs ---- */
const clubs = Object.values(raw.teams).map(t => {
  const logo = t.logo ? (raw.logos[t.logo] || '') : '';
  const c1 = PALETTE[hash(t.id) % PALETTE.length];
  const c2 = PALETTE[(hash(t.id) + 7) % PALETTE.length];
  return { id: t.id, name: t.name, short: stripSuffix(t.name), abbr: abbrev(t.name), area: '', c1, c2, logo, div: '' };
});
const byId = {}; clubs.forEach(c => byId[c.id] = c);
const NAMEMAP = {};
clubs.forEach(c => { NAMEMAP[c.name.toUpperCase()] = c.id; NAMEMAP[c.short.toUpperCase()] = c.id; });
const cid = n => NAMEMAP[String(n || '').trim().toUpperCase()] || '';

/* ---- competitions ---- */
const slug = (name, year) => name.toLowerCase()
  .replace(/kampionato\s*(ffk\s*)?/,'')
  .replace(/\d{4}(\s*-\s*\d{2,4})?/g,'')
  .replace(/divishon/,'d')
  .replace(/[^a-z]+/g,'').slice(0,12) + year;
const shortOf = n => {
  let t = n.replace(/Kampionato\s*(FFK\s*)?/i,'').replace(/\d{4}(\s*-\s*\d{2,4})?/g,'').replace(/Divishon/i,'').trim();
  t = t.replace(/Kopa\s+Korsou/i,'Kopa').replace(/\s+/g,' ').trim();
  return t.replace(/^[-–\s]+|[-–\s]+$/g,'') || n;
};
const tierOf = n => /prome|promé/i.test(n) ? 1 : /segunda|segundo/i.test(n) ? 2 : /terser/i.test(n) ? 3 : /femenino/i.test(n) ? 4 : 0;

const phaseKey = (label, q) => {
  const pool = (q.match(/poolNumber=(-?\d+)/) || [])[1];
  const lbl = label.replace(/\s+/g, ' ').trim();
  if (/^Poule\s+([A-Z])$/i.test(lbl)) return 'poule' + lbl.split(/\s+/)[1].toUpperCase();
  if (/^Group\s+([A-Z])$/i.test(lbl)) return 'group' + lbl.split(/\s+/)[1].toUpperCase();
  const base = lbl.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'main';
  return pool && pool !== '-1' ? base + 'p' + pool : base;
};

const to24 = t => {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return String(t || '').trim();
  let h = +m[1];
  if (m[3]) { const pm = /PM/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return String(h).padStart(2, '0') + ':' + m[2];
};
const today = new Date().toISOString().slice(0, 10);
const divisions = [], tables = {}, leaders = {}, matches = [];
let mn = 0;

raw.competitions.forEach(comp => {
  const id = slug(comp.name, comp.year);
  const groups = [];
  tables[id] = {};
  comp.standings.forEach(st => {
    /* The scraper already hands over one row per club, with the club's own id in
       position 1. Two things were wrong here and both ended in an empty table:
       the first club was sliced off as if it were a header, and the id was looked
       up as if it were a name. An empty table is not loud, it just leaves the old
       one standing, so this had to be read closely rather than trusted. */
    const rows = st.rows
      .map(r => r.filter(x => x !== ''))
      .filter(r => r.length >= 9)
      .map(r => {
        const nums = r.slice(-8).map(Number);
        const club = byId[String(r[1] || '').trim()] ? String(r[1]).trim() : cid(r[1]);
        return [Number(r[0]), club, nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], nums[6], nums[7]];
      })
      .filter(r => r[1] && Number.isFinite(r[0]));
    if (!rows.length) return;
    const k = phaseKey(st.label, st.q);
    if (tables[id][k]) return;
    /* The phase level standings page, with no poule picked, just repeats one of
       the poules. Left in it shows up as a duplicate group, and whichever of the
       two arrives first wins, which is how a real Poule D once lost its place to
       a copy of itself called fase2kk. A named poule always wins. */
    const sig = JSON.stringify(rows);
    const dupe = Object.keys(tables[id]).filter(x => JSON.stringify(tables[id][x]) === sig)[0];
    const named = x => /^(poule|group)[A-Z]$/.test(x);
    if (dupe) {
      if (!(named(k) && !named(dupe))) return;
      delete tables[id][dupe];
      const at = groups.findIndex(g => g[0] === dupe);
      if (at >= 0) groups.splice(at, 1);
    }
    tables[id][k] = rows;
    groups.push([k, st.label.replace(/\s+/g, ' ').trim()]);
    rows.forEach(r => { if (byId[r[1]] && !byId[r[1]].div) byId[r[1]].div = id; });
  });

  /* leaders */
  const L = comp.leaders || {};
  const parseList = rows => {
    const out = [];
    (rows || []).forEach(r => {
      if (!Array.isArray(r) || r.length < 3) return;
      const club = cid(r[1]);
      const v = String(r[2]).includes(':') ? parseInt(r[2], 10) : Number(r[2]);
      if (!club || !isFinite(v)) return;
      out.push([String(r[0]).trim(), club, v]);
    });
    /* highest first, and no duplicate names inside one chart */
    const seen = {};
    return out.sort((a, b) => b[2] - a[2]).filter(r => seen[r[0]] ? false : (seen[r[0]] = 1));
  };
  const lead = {
    goals: parseList(L['Goals']), assists: parseList(L['Assists']),
    clean: parseList(L['Clean sheets']), yc: parseList(L['Yellow cards']),
    rc: parseList(L['Red cards']), mins: parseList(L['Minutes'])
  };
  if (Object.values(lead).some(a => a.length)) leaders[id] = lead;

  /* matches */
  const groupOfMatch = {};
  comp.matches.forEach(m => {
    if (!m.home || !m.away) return;
    /* The federation's own match number, not a position in a list. Numbering
       these m1, m2, m3 in scrape order meant every id moved whenever the feed
       gained or reordered a match, and a result a referee had already recorded
       then belonged to a different game. The feed's own id never moves. */
    matches.push({
      id: m.mid ? ('f' + m.mid) : ('m' + (++mn)),
      ffk: m.mid || '',
      div: id, group: groupOfMatch[m.mid] || '', md: 0,
      phase: m.phase || '',
      date: m.date, time: to24(m.time),
      venue: m.venue || '', ref: m.referee || '',
      home: m.home, away: m.away, hs: m.hs || 0, as: m.as || 0,
      status: m.status, events: [], att: 0, potm: '',
      officials: { ref: '', ar1: '', ar2: '', fourth: '' }, respect: { home: 0, away: 0 }
    });
  });

  const dates = comp.matches.map(m => m.date).filter(Boolean).sort();
  const last = dates[dates.length - 1] || '';
  const status = comp.matches.some(m => m.status === 'live') ? 'live'
    : (last && last >= today ? 'live' : 'done');

  /* A cup ends in a bracket, not a table. Everything below is wrapped so that a
     surprise in the federation's data can never take the rest of the file down. */
  try {
    const mine = matches.filter(m => m.div === id);
    /* Knock out phases. The federation names them in several ways: "Fase 3 KK
       (Knock out fase)", "Fase 4 KK (Kuart finale)", semi finals, the final. Only
       cups have a bracket; a league's "Finale" or "Playoff Kaya 6" is not one. */
    const KO = /knock\s*-?\s*out|\bk\.?o\.?\b|kuart|quarter|kwart|semi|octav|\bfinal/i;
    const koList = tierOf(comp.name) ? [] : mine.filter(m => KO.test(m.phase || ''));
    if (koList.length) {
      /* Each named phase is its own round, in the order they are played. Inside a
         phase, a club playing twice means the next round has started. */
      const when = m => m.date + ' ' + (m.time || '');
      const byPhase = {};
      koList.forEach(m => (byPhase[m.phase] = byPhase[m.phase] || []).push(m));
      const phaseOrder = Object.keys(byPhase).sort((a, b) => {
        const fa = byPhase[a].map(when).sort()[0], fb = byPhase[b].map(when).sort()[0];
        return fa.localeCompare(fb);
      });
      let round = 0;
      phaseOrder.forEach(ph => {
        const sorted = byPhase[ph].slice().sort((a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id));
        round++;
        let seen = {};
        sorted.forEach(m => {
          if (seen[m.home] || seen[m.away]) { round++; seen = {} }
          seen[m.home] = 1; seen[m.away] = 1;
          m.ko = true; m.round = round;
        });
      });
    }

    /* Clubs that played a group match but sit in no poule the federation lists.
       Their poule exists, it is just missing from the menu, so work it out. */
    const inGroup = {};
    Object.keys(tables[id] || {}).forEach(k => (tables[id][k] || []).forEach(r => { inGroup[r[1]] = 1 }));
    const orphanMs = mine.filter(m => !m.ko && !inGroup[m.home] && !inGroup[m.away]);
    if (orphanMs.length && Object.keys(tables[id] || {}).length) {
      const row = {};
      const put = c => (row[c] = row[c] || { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
      orphanMs.forEach(m => {
        put(m.home); put(m.away);
        if (m.status !== 'ft') return;
        const h = row[m.home], a = row[m.away];
        h.p++; a.p++; h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
        if (m.hs > m.as) { h.w++; h.pts += 3; a.l++ }
        else if (m.as > m.hs) { a.w++; a.pts += 3; h.l++ }
        else { h.d++; a.d++; h.pts++; a.pts++ }
      });
      const order = Object.keys(row).sort((x, y) =>
        row[y].pts - row[x].pts ||
        (row[y].gf - row[y].ga) - (row[x].gf - row[x].ga) ||
        row[y].gf - row[x].gf || String(x).localeCompare(String(y)));
      const rows = order.map((c, i) => {
        const r = row[c];
        return [i + 1, c, r.p, r.w, r.l, r.d, r.gf, r.ga, r.pts, r.gf - r.ga];
      });
      /* Name it after the letter missing from the groups that are listed, in the
         same style: Group X and Group Z are missing Group Y, Poule A to H with no D
         are missing Poule D. The gap is looked for between the first and last
         letter the federation uses, not from A. */
      const named = groups.map(g => /^(poule|group)([A-Z])$/.exec(g[0])).filter(Boolean);
      const pre = named.length ? named[0][1] : 'poule';
      const word = pre === 'group' ? 'Group' : 'Poule';
      const letters = named.filter(x => x[1] === pre).map(x => x[2]);
      let letter = '';
      if (letters.length) {
        const have = {}; letters.forEach(l => have[l] = 1);
        const codes = letters.map(l => l.charCodeAt(0)).sort((a, b) => a - b);
        const lo = codes[0], hi = codes[codes.length - 1];
        for (let cc = lo; cc <= hi; cc++) if (!have[String.fromCharCode(cc)]) { letter = String.fromCharCode(cc); break }
        if (!letter && hi < 90) letter = String.fromCharCode(hi + 1);
      }
      const key = letter ? pre + letter : pre + 'Extra';
      if (rows.length && !tables[id][key]) {
        tables[id][key] = rows;
        groups.push([key, letter ? word + ' ' + letter : word]);
        groups.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      }
    }
  } catch (e) {
    console.log('[build] cup shape skipped for', id, e.message);
  }

  /* Adrian's call: the second phase of the Kopa is shown as the Knockout, not
     "Fase 2". The id stays the same, so stored results and settings still match. */
  const shown = !tierOf(comp.name) && /\bfase\s*2\b/i.test(comp.name)
    ? comp.name.replace(/\bfase\s*2\b/i, 'Knockout') : comp.name;
  divisions.push({
    id, name: shown, short: shortOf(shown), en: shown,
    ...(shown !== comp.name ? { phase: 'Knockout' } : {}),
    type: tierOf(comp.name) ? 'league' : 'cup', season: comp.year,
    status, tier: tierOf(comp.name), cfu: tierOf(comp.name) === 1 ? 2 : 0, groups
  });
});

/* live competition first, then newest */
divisions.sort((a, b) =>
  (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) ||
  b.season.localeCompare(a.season) || (a.tier || 9) - (b.tier || 9));

/* referees named on the match sheets */
const refNames = [...new Set(matches.map(m => m.ref).filter(n => n && n.length > 4))].sort();
const referees = refNames.map((n, i) => ({ id: 'r' + (i + 1), name: n, area: '', since: 0, active: true }));
const refByName = {}; referees.forEach(r => refByName[r.name] = r.id);
matches.forEach(m => { if (m.ref && refByName[m.ref]) m.officials.ref = refByName[m.ref]; });

/* Keys the admin owns. The FFK never publishes these, so an update must never
   flatten them. Whatever is already in data.json wins, then editorial.json,
   then the scraped fallback. That way edits published from the app survive. */
const OWNED = ['transfers','news','referees','refledger','refrules','refinfo',
               'rewards','sponsors','refstart','ads','adsettings','adminpin'];
const prev = fs.existsSync(OUT) ? (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch (e) { return {} }
})() : {};

const data = Object.assign({
  v: 3, season: divisions[0] ? divisions[0].season : String(new Date().getFullYear()),
  updated: today, source: 'ffk.cw',
  fed: { name: 'Federashon Futbol Kòrsou', abbr: 'FFK', site: 'https://ffk.cw/' },
  divisions, clubs, tables, leaders, matches, players: [], referees
}, editorial);

OWNED.forEach(k => {
  if (prev[k] !== undefined) data[k] = prev[k];
  else if (editorial[k] !== undefined) data[k] = editorial[k];
});
delete data._comment;

fs.writeFileSync(OUT, JSON.stringify(data));
log('competitions', divisions.length, '| clubs', clubs.length,
    '| badges', clubs.filter(c => c.logo).length, '| matches', matches.length,
    '| referees', referees.length, '|', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
divisions.forEach(d => log(' ', d.status === 'live' ? '●' : ' ', d.short, d.season,
  Object.keys(tables[d.id] || {}).length + ' tables',
  (leaders[d.id] ? 'stats' : 'no stats')));
const unmapped = matches.filter(m => !byId[m.home] || !byId[m.away]).length;
if (unmapped) log('WARNING: unmapped clubs in', unmapped, 'matches');
