/* Add a fixture to 599 Scores from the command line.
 *
 * The Editor on your phone does the same thing with a button. This is for when
 * you would rather type it, or paste a whole evening in one go.
 *
 *   node tools/addgame.mjs --div kopakorsouw2026 --date 2026-09-21 --time 19:00 \
 *        --home 16994 --away 10098 --venue "Kancha Sentral" --ref "Nòmber di e arbiter"
 *
 * Add --season "Kopa Kòrsou W|kopakorsouw2025|2026" to open a season first,
 * copying the club list from an earlier one.
 * List what you can pick with:  node tools/addgame.mjs --list
 *
 * It asks for your admin key and never writes it to a file. It reads what is
 * published, adds to it, and puts it back, so nothing else you published is
 * touched.
 */
import { createInterface } from 'node:readline';

const API  = process.env.API_URL  || 'https://scores599-api.a3dprinting.workers.dev';
const DATA = process.env.DATA_URL || 'https://a3dprinting.github.io/599-scores/data.json';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] || '').startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i];
}
const die = m => { console.error('\n' + m + '\n'); process.exit(1) };

const data = await fetch(DATA, { cache: 'no-store' }).then(r => r.json()).catch(() => die('cannot read data.json at ' + DATA));
const clubs = {}; (data.clubs || []).forEach(c => clubs[c.id] = c.name || c.short);
const divs  = {}; (data.divisions || []).forEach(d => divs[d.id] = d.name);

if (args.list) {
  console.log('\nCompetitions\n' + Object.entries(divs).map(([k, v]) => '  ' + k.padEnd(20) + v).join('\n'));
  console.log('\nClubs\n' + Object.entries(clubs).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([k, v]) => '  ' + k.padEnd(8) + v).join('\n'));
  process.exit(0);
}

/* --season names the competition itself, so --div is only needed without it. */
const need = (typeof args.season === 'string' ? [] : ['div']).concat(['date', 'home', 'away']);
for (const k of need) if (typeof args[k] !== 'string') die('missing --' + k + '   (try --list, or --help in the file header)');
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) die('--date wants 2026-09-21');
if (args.home === args.away) die('the same club cannot play itself');
for (const k of ['home', 'away']) if (!clubs[args[k]]) die('no club with id ' + args[k] + '   (run --list)');

const key = await new Promise(res => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Admin key: ', v => { rl.close(); res(v.trim()) });
});
if (!key) die('no key, nothing sent');
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + key };

const got = await fetch(API + '/content?t=' + Date.now()).then(r => r.json()).catch(() => die('cannot reach ' + API));
const content = got.content || {};

if (typeof args.season === 'string') {
  const [name, from, year] = args.season.split('|');
  if (!name || !from || !/^\d{4}$/.test(year || '')) die('--season wants "Name|previous-season-id|2026"');
  const src = (data.divisions || []).find(d => d.id === from) || die('no competition with id ' + from);
  const id = String(from).replace(/\d{4}$/, '') + year;
  content.newseasons = content.newseasons || [];
  if (!content.newseasons.some(n => n.id === id) && !divs[id]) {
    const roster = [...new Set((data.matches || []).filter(m => m.div === from).flatMap(m => [m.home, m.away]))];
    content.newseasons.push({ id, name: name + ' ' + year, short: name, en: name + ' ' + year,
      type: src.type || 'cup', season: year, status: 'live', tier: src.tier || 0, clubs: roster });
    console.log('opened ' + id + ' with ' + roster.length + ' clubs');
  } else console.log(id + ' already exists, leaving it alone');
  args.div = id;
}

const fx = {
  id: 'x' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100),
  div: args.div, date: args.date, time: typeof args.time === 'string' ? args.time : '19:00',
  home: args.home, away: args.away,
  venue: typeof args.venue === 'string' ? args.venue : '',
  ref: typeof args.ref === 'string' ? args.ref : ''
};
content.ownmatches = content.ownmatches || [];
const same = content.ownmatches.find(m => m.div === fx.div && m.date === fx.date && m.home === fx.home && m.away === fx.away);
if (same) die('that fixture is already in there as ' + same.id);
content.ownmatches.push(fx);

const res = await fetch(API + '/admin/content', { method: 'POST', headers: H, body: JSON.stringify(content) });
const out = await res.json().catch(() => ({}));
if (!res.ok) die('the server said no: ' + (out.error || res.status));
console.log('\n' + clubs[fx.home] + ' v ' + clubs[fx.away] + '   ' + fx.date + ' ' + fx.time +
            '\nin ' + fx.div + ', id ' + fx.id + '\nevery phone has it on next open.\n');
