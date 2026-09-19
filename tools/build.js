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
    const rows = st.rows.slice(1)
      .map(r => r.filter(x => x !== ''))
      .filter(r => r.length >= 9)
      .map(r => {
        const nums = r.slice(-8).map(Number);
        return [Number(r[0]), cid(r[1]), nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], nums[6], nums[7]];
      })
      .filter(r => r[1]);
    if (!rows.length) return;
    const k = phaseKey(st.label, st.q);
    if (tables[id][k]) return;
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
    matches.push({
      id: 'm' + (++mn), div: id, group: groupOfMatch[m.matchId] || '', md: 0,
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

  divisions.push({
    id, name: comp.name, short: shortOf(comp.name), en: comp.name,
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
