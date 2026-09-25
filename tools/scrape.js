/* Reads the Curacao football database and writes raw.json.
   ffk.cw renders a Genius Sports feed. The feed itself is served as plain HTML at
   hosted.dcd.shared.geniussports.com/CUW/en/... so no browser is needed. */
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const BASE = 'https://hosted.dcd.shared.geniussports.com/CUW/en';
const OUT = path.join(__dirname, 'raw.json');
const log = (...a) => console.log('[scrape]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(p, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(BASE + p, { headers: { 'user-agent': 'korsou-futbol-updater' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      log('retry', i, p, e.message);
      await sleep(800 * i);
    }
  }
  return '';
}
const dom = html => parseHTML(html || '<html></html>').document;
const txt = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
const teamId = el => {
  const a = el && el.querySelector('a[href*="/team/"]');
  return a ? ((a.getAttribute('href') || '').match(/team\/(\d+)/) || [])[1] || '' : '';
};

const TEAMS = {};
function noteTeam(id, name, code, logo) {
  if (!id) return;
  const t = TEAMS[id] = TEAMS[id] || { id, name: '', code: '', logo: '' };
  if (name && name.trim()) t.name = name.trim();
  if (code && code.trim()) t.code = code.trim();
  if (logo) t.logo = logo;
}

function competitions(html) {
  const re = /compdata\.push\(\['([^']*)','([^']*)',\s*(\d+),\s*'(\d+)',\s*(\d+)\]\)/g;
  const out = {}; let m;
  while ((m = re.exec(html))) out[m[5] + '|' + m[4]] = { id: m[5], name: m[2], year: m[4] };
  return Object.values(out);
}

function phases(html) {
  const d = dom(html), seen = {};
  return [...d.querySelectorAll('a')]
    .map(a => ({ label: txt(a), href: a.getAttribute('href') || '' }))
    .filter(x => /phaseName|poolNumber/.test(x.href))
    .map(x => ({ label: x.label, q: x.href.slice(x.href.indexOf('?') + 1) }))
    .filter(x => x.q && !seen[x.q] && (seen[x.q] = 1));
}

/* The competition's own phases, by name. The federation keeps a group stage and
   a knock out as separate phases, and a match means something different in each,
   so every match has to carry the one it came from. */
function phaseNames(html) {
  const seen = {};
  return phases(html).map(x => {
    const m = /phaseName=([^&]*)/.exec(x.q);
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() } catch (e) { return m[1].replace(/\+/g, ' ').trim() }
  }).filter(l => l && !seen[l] && (seen[l] = 1));
}

const dates = html => [...new Set(
  (html.match(/SelectedDates\[['"](\d{4}-\d{2}-\d{2})/g) || []).map(s => s.slice(-10)))];

function standings(html) {
  const d = dom(html), t = d.querySelector('table');
  if (!t) return [];
  const rows = [];
  [...t.querySelectorAll('tr')].slice(1).forEach(r => {
    const id = teamId(r);
    noteTeam(id, txt(r.querySelector('.team-name-full')), txt(r.querySelector('.team-name-code')),
      r.querySelector('img') ? r.querySelector('img').getAttribute('src') : '');
    const nums = [...r.children].map(c => txt(c)).filter(x => /^-?\d+$/.test(x)).map(Number);
    if (id && nums.length >= 9) rows.push([nums[0], id].concat(nums.slice(1, 9)));
  });
  return rows;
}

function leaders(html) {
  const d = dom(html), out = {};
  const UNIT = { G: 'goals', Clean: 'clean', Min: 'mins', YC: 'yc', RC: 'rc', AST: 'assists' };
  [...d.querySelectorAll('.leader-block')].forEach(bl => {
    let k = UNIT[txt(bl.querySelector('.ld-statname'))];
    const t = bl.querySelector('table');
    if (!k && t) {
      const h = t.querySelector('tr');
      if (h) k = UNIT[[...h.children].map(x => txt(x))[2]];
    }
    if (!k) return;
    const rows = [];
    const lf = bl.querySelector('.leader-first');
    if (lf) {
      const id = teamId(lf);
      const nm = txt(lf.querySelector('.ld-name a'));
      const v = txt(lf.querySelector('.leader-first-value')).replace(/[A-Za-z]/g, '').trim();
      if (nm && id && v) rows.push([nm, id, v]);
    }
    if (t) [...t.querySelectorAll('tr')].slice(1).forEach(r => {
      const c = [...r.children].map(x => txt(x));
      const id = teamId(r);
      if (c[0] && c[2] && id) rows.push([c[0], id, c[2]]);
    });
    if (rows.length) out[k] = rows;
  });
  return out;
}

/* The feed shows the date inside each match as "Date / Time: Aug 17, 2026, 9:00 PM".
   It used to list the dates in a script block; that went away on 24 September 2026. */
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function matchDate(s) {
  const m = /([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4})/.exec(s || '');
  if (!m || !MON[m[1]]) return '';
  return m[3] + '-' + String(MON[m[1]]).padStart(2, '0') + '-' + m[2].padStart(2, '0');
}

function fixtures(html, date) {
  const d = dom(html), out = [];
  [...d.querySelectorAll('.match-wrap')].forEach(box => {
    const cls = box.className || '';
    const status = /STATUS_COMPLETE/.test(cls) ? 'ft'
      : /STATUS_LIVE|STATUS_IN_PROGRESS/.test(cls) ? 'live'
      : /STATUS_CANCEL|STATUS_POSTPON/.test(cls) ? 'post' : 'sched';
    const when = txt(box.querySelector('.match-time'));
    const time = (txt(box.querySelector('.match-time span')).match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i) ||
                  when.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i) || [])[1] || '';
    const day = matchDate(when) || date || '';
    const venue = txt(box.querySelector('.venuename'));
    const ref = txt(box.querySelector('.officialsname'));
    function side(sel) {
      const w = box.querySelector(sel);
      if (!w) return null;
      const id = teamId(w);
      noteTeam(id, txt(w.querySelector('.team-name-full')), txt(w.querySelector('.team-name-code')),
        w.querySelector('img') ? w.querySelector('img').getAttribute('src') : '');
      return { id, score: parseInt(txt(w.querySelector('.fake-cell')), 10) };
    }
    const h = side('.home-team'), a = side('.away-team');
    if (!h || !a || !h.id || !a.id) return;
    out.push({
      mid: ((box.id || '').match(/(\d+)/) || [])[1] || '',
      date: day, time, venue, ref, home: h.id, away: a.id,
      hs: isNaN(h.score) ? 0 : h.score, as: isNaN(a.score) ? 0 : a.score, status
    });
  });
  return out;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]) } catch (e) { out[k] = null } }
  }));
  return out;
}

async function logosAsDataURIs(urls) {
  let sharp = null;
  try { sharp = require('sharp') } catch (e) { log('sharp not installed, badges will keep their source URLs') }
  const out = {};
  await pool([...new Set(urls.filter(Boolean))], 6, async u => {
    try {
      const r = await fetch(u); if (!r.ok) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (sharp) {
        const webp = await sharp(buf).resize(72, 72, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 82 }).toBuffer();
        out[u] = 'data:image/webp;base64,' + webp.toString('base64');
      } else {
        out[u] = 'data:' + (r.headers.get('content-type') || 'image/png') + ';base64,' + buf.toString('base64');
      }
    } catch (e) {}
  });
  return out;
}

(async () => {
  const seed = await get('/competition/2048/standings?');
  let comps = competitions(seed);
  if (!comps.length) { log('could not read the competition list'); process.exit(1); }
  if (process.env.FFK_ONLY) {
    const want = process.env.FFK_ONLY.split(',').map(s => s.trim());
    comps = comps.filter(c => want.includes(c.id));
  }
  log('competitions:', comps.map(c => `${c.year}/${c.id} ${c.name}`).join(' | '));

  const raw = { scrapedAt: new Date().toISOString(), competitions: [], teams: TEAMS, logos: {} };

  for (const c of comps) {
    log('---', c.name);
    const entry = { ...c, standings: [], leaders: {}, matches: [] };
    const top = await get(`/competition/${c.id}/standings?`);
    let ph = phases(top);
    if (!ph.length) ph = [{ label: 'main', q: '' }];
    for (const p of ph) {
      const rows = standings(await get(`/competition/${c.id}/standings?${p.q}`));
      if (rows.length) entry.standings.push({ label: p.label, q: p.q, rows });
    }
    entry.leaders = leaders(await get(`/competition/${c.id}/leaders?`));
    const teamsPage = dom(await get(`/competition/${c.id}/teams?`));
    [...teamsPage.querySelectorAll('a[href*="/team/"]')].forEach(a => {
      const id = ((a.getAttribute('href') || '').match(/team\/(\d+)/) || [])[1];
      const img = a.querySelector('img');
      noteTeam(id, txt(a), '', img ? img.getAttribute('src') : '');
    });

    const seen = {};

    /* roundNumber=-1 makes the feed return every match of the competition on one
       page (without it, only the current round). Phase by phase first, so each
       match keeps the phase it was played in, then the whole list to catch any
       match that sits outside a named phase. */
    const ALL = 'roundNumber=-1';
    for (const lbl of phaseNames(top)) {
      const q = 'phaseName=' + encodeURIComponent(lbl) + '&' + ALL;
      const got = fixtures(await get(`/competition/${c.id}/schedule?${q}`), '');
      got.forEach(m => { if (m.mid && !seen[m.mid]) { seen[m.mid] = 1; m.phase = lbl; entry.matches.push(m) } });
      log('  phase', lbl, '->', got.length);
    }
    fixtures(await get(`/competition/${c.id}/schedule?${ALL}`), '')
      .forEach(m => { if (m.mid && !seen[m.mid]) { seen[m.mid] = 1; m.phase = m.phase || ''; entry.matches.push(m) } });
    const undated = entry.matches.filter(m => !m.date).length;
    if (undated) log('  WARNING', undated, 'matches without a date');
    log('  fixtures:', entry.matches.length, '| tables:', entry.standings.length);
    raw.competitions.push(entry);
  }

  log('badges:', Object.values(TEAMS).filter(t => t.logo).length);
  raw.logos = await logosAsDataURIs(Object.values(TEAMS).map(t => t.logo));
  fs.writeFileSync(OUT, JSON.stringify(raw));
  log('wrote', OUT, (fs.statSync(OUT).size / 1024 | 0) + ' KB');
})();
