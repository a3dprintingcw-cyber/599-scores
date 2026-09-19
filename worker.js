// src/lib.js
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var today = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra }
  });
}
var bad = (msg, status = 400) => json({ error: msg }, status);
function corsHeaders(req, env) {
  const allowed = (env.ALLOW_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const ok = allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0] || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
}
var enc = new TextEncoder();
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 12e4, hash: "SHA-256" },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makePinHash(pin) {
  const salt = token(16);
  return salt + "$" + await hashPin(pin, salt);
}
async function checkPin(pin, stored) {
  if (!stored || stored.indexOf("$") < 0)
    return false;
  const [salt, want] = stored.split("$");
  const got = await hashPin(pin, salt);
  return timingSafeEqual(got, want);
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let out = 0;
  for (let i = 0; i < a.length; i++)
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function token(n = 32) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, n * 2);
}
function inviteCode() {
  const A = "ACDEFGHJKLMNPQRTUVWXY3479";
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < 8; i++)
    s += A[b[i] % A.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}
var SESSION_DAYS = 120;
async function newSession(env, kind, subject) {
  const t = token(24);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, kind, subject, created_at, expires_at) VALUES (?,?,?,?,?)"
  ).bind(t, kind, subject, now(), exp).run();
  return { token: t, expires: exp };
}
async function session(req, env) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!t)
    return null;
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT token, kind, subject, expires_at FROM sessions WHERE token = ?"
    ).bind(t).first();
  } catch (e) {
    return null;
  }
  if (!row)
    return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
    return null;
  }
  return row;
}
async function refFromSession(req, env) {
  const s = await session(req, env);
  if (!s || s.kind !== "ref")
    return null;
  const r = await env.DB.prepare(
    "SELECT id, name, ffk_name, role, area, active FROM referees WHERE id = ?"
  ).bind(s.subject).first();
  if (!r || !r.active)
    return null;
  return r;
}
async function userFromSession(req, env) {
  const s = await session(req, env);
  if (!s || s.kind !== "user")
    return null;
  return await env.DB.prepare(
    "SELECT id, name, email, club FROM users WHERE id = ?"
  ).bind(s.subject).first();
}
async function audit(env, who, kind, matchId, detail) {
  await env.DB.prepare(
    "INSERT INTO audit (at, who, kind, match_id, detail) VALUES (?,?,?,?,?)"
  ).bind(now(), who, kind, matchId || null, detail ? JSON.stringify(detail) : null).run();
}
async function rateLimit(env, key, limit, windowSec) {
  if (!env.RL)
    return true;
  const k = "rl:" + key;
  const cur = parseInt(await env.RL.get(k) || "0", 10);
  if (cur >= limit)
    return false;
  await env.RL.put(k, String(cur + 1), { expirationTtl: windowSec });
  return true;
}

// src/index.js
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS referees (
  id          TEXT PRIMARY KEY,          -- r1, r2 ...
  name        TEXT NOT NULL,             -- display name
  ffk_name    TEXT NOT NULL,             -- exactly as it appears on the FFK match sheet
  phone       TEXT,
  area        TEXT,
  role        TEXT NOT NULL DEFAULT 'ref',   -- ref | admin
  pin_hash    TEXT,                      -- set by the referee on first login
  invite      TEXT,                      -- one time code, cleared once used
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ffk ON referees(ffk_name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_invite ON referees(invite) WHERE invite IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- u_<random>
  sub         TEXT UNIQUE,               -- google subject
  email       TEXT,
  name        TEXT NOT NULL,
  club        TEXT,                      -- favourite club id
  created_at  TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,             -- ref | user
  subject     TEXT NOT NULL,             -- referees.id or users.id
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_sess_exp ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS match_state (
  match_id    TEXT PRIMARY KEY,
  status      TEXT NOT NULL,             -- sched | live | ht | ft
  minute      INTEGER,
  hs          INTEGER NOT NULL DEFAULT 0,
  as_         INTEGER NOT NULL DEFAULT 0,
  confirmed   INTEGER NOT NULL DEFAULT 0,-- 1 once the referee signs it off
  by_ref      TEXT,
  updated_at  TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_ms_upd ON match_state(updated_at)`,
  `CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL,
  min         INTEGER NOT NULL,
  type        TEXT NOT NULL,             -- goal | pen | og | yc | rc
  team        TEXT NOT NULL,             -- club id
  player      TEXT,                      -- free text, the referee may not know squad ids
  by_ref      TEXT NOT NULL,
  at          TEXT NOT NULL,
  void        INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE INDEX IF NOT EXISTS idx_ev_match ON events(match_id)`,
  `CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  who         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  match_id    TEXT,
  detail      TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at)`,
  `CREATE TABLE IF NOT EXISTS predictions (
  user_id     TEXT NOT NULL,
  match_id    TEXT NOT NULL,
  home        INTEGER NOT NULL,
  away        INTEGER NOT NULL,
  season      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, match_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pred_season ON predictions(season)`,
  `CREATE TABLE IF NOT EXISTS results (
  match_id    TEXT PRIMARY KEY,
  hs          INTEGER NOT NULL,
  as_         INTEGER NOT NULL,
  season      TEXT NOT NULL,
  kickoff     TEXT,
  scored_at   TEXT
)`,
  `CREATE TABLE IF NOT EXISTS standings_fan (
  season      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  pts         INTEGER NOT NULL DEFAULT 0,
  exact       INTEGER NOT NULL DEFAULT 0,
  outcome     INTEGER NOT NULL DEFAULT 0,
  played      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_fan_pts ON standings_fan(season, pts DESC)`
];
var src_default = {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      const res = await route(p, req, env, url, ctx);
      for (const [k, v] of Object.entries(cors))
        res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e && e.stack || e);
      const res = bad("server error", 500);
      for (const [k, v] of Object.entries(cors))
        res.headers.set(k, v);
      return res;
    }
  }
};
async function route(p, req, env, url, ctx) {
  const POST = req.method === "POST";
  const body = POST ? await req.json().catch(() => ({})) : {};
  if (p === "/" || p === "/health") {
    return json({ ok: true, service: "599-scores-api", time: now() });
  }
  if (p === "/live")
    return live(env);
  if (p === "/auth/ref/claim" && POST) {
    const code = String(body.code || "").trim().toUpperCase();
    const pin = String(body.pin || "");
    if (!/^\d{4,8}$/.test(pin))
      return bad("pin must be 4 to 8 digits");
    if (!await rateLimit(env, "claim:" + (req.headers.get("cf-connecting-ip") || "x"), 10, 900))
      return bad("too many attempts, wait 15 minutes", 429);
    const r = await env.DB.prepare(
      "SELECT id, name FROM referees WHERE invite = ? AND active = 1"
    ).bind(code).first();
    if (!r)
      return bad("that code is not valid", 401);
    const hash = await makePinHash(pin);
    await env.DB.prepare(
      "UPDATE referees SET pin_hash = ?, invite = NULL WHERE id = ?"
    ).bind(hash, r.id).run();
    await audit(env, r.id, "ref.claim", null, { name: r.name });
    const s = await newSession(env, "ref", r.id);
    return json({ token: s.token, referee: { id: r.id, name: r.name } });
  }
  if (p === "/auth/ref/login" && POST) {
    const who = String(body.id || body.phone || "").trim();
    const pin = String(body.pin || "");
    if (!who || !pin)
      return bad("missing id or pin");
    if (!await rateLimit(env, "login:" + who, 12, 900))
      return bad("too many attempts, wait 15 minutes", 429);
    const r = await env.DB.prepare(
      "SELECT id, name, pin_hash, active FROM referees WHERE (id = ? OR phone = ?) AND active = 1"
    ).bind(who, who).first();
    if (!r || !r.pin_hash)
      return bad("wrong id or pin", 401);
    if (!await checkPin(pin, r.pin_hash))
      return bad("wrong id or pin", 401);
    const s = await newSession(env, "ref", r.id);
    await audit(env, r.id, "ref.login", null, null);
    return json({ token: s.token, referee: { id: r.id, name: r.name } });
  }
  if (p === "/auth/logout" && POST) {
    const s = await session(req, env);
    if (s)
      await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(s.token).run();
    return json({ ok: true });
  }
  if (p === "/ref/me") {
    const r = await refFromSession(req, env);
    if (!r)
      return bad("not signed in", 401);
    const mine = await myMatches(env, r);
    return json({ referee: { id: r.id, name: r.name, role: r.role, area: r.area }, matches: mine });
  }
  if (p.startsWith("/ref/match/") && POST) {
    const r = await refFromSession(req, env);
    if (!r)
      return bad("not signed in", 401);
    const parts = p.split("/");
    const matchId = parts[3];
    const action = parts[4] || "";
    const appt = await appointment(env, r, matchId);
    if (!appt.ok)
      return bad(appt.why, 403);
    if (action === "start")
      return setStatus(env, r, matchId, "live", body);
    if (action === "ht")
      return setStatus(env, r, matchId, "ht", body);
    if (action === "resume")
      return setStatus(env, r, matchId, "live", body);
    if (action === "event")
      return addEvent(env, r, matchId, body);
    if (action === "undo")
      return undoEvent(env, r, matchId, body);
    if (action === "score")
      return setScore(env, r, matchId, body);
    if (action === "confirm")
      return confirmMatch(env, r, matchId, body);
    return bad("unknown action");
  }
  if (p === "/auth/google" && POST)
    return googleAuth(env, body);
  if (p === "/me")
    return meUser(req, env);
  if (p === "/predictions" && !POST)
    return myPredictions(req, env, url);
  if (p === "/predictions" && POST)
    return savePrediction(req, env, body);
  if (p === "/leaderboard")
    return leaderboard(req, env, url);
  if (p.startsWith("/admin/"))
    return adminRoute(p, req, env, body, POST);
  return bad("not found", 404);
}
async function appointment(env, r, matchId) {
  if (r.role === "admin")
    return { ok: true };
  const fx = await fixture(env, matchId);
  if (!fx)
    return { ok: false, why: "match not found" };
  const nameMatch = fx.ref && r.ffk_name && fx.ref.trim().toLowerCase() === r.ffk_name.trim().toLowerCase();
  if (!nameMatch)
    return { ok: false, why: "you are not appointed to this match" };
  const d = fx.date;
  const t = today();
  const dayBefore = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (d !== t && d !== dayBefore)
    return { ok: false, why: "this match is not today" };
  return { ok: true, fixture: fx };
}
var FIX_CACHE = { at: 0, byId: null };
async function fixtures(env) {
  if (FIX_CACHE.byId && Date.now() - FIX_CACHE.at < 3e5)
    return FIX_CACHE.byId;
  const res = await fetch(env.DATA_URL, { cf: { cacheTtl: 120 } });
  if (!res.ok)
    throw new Error("cannot read data.json");
  const d = await res.json();
  const byId = {};
  (d.matches || []).forEach((m) => {
    byId[m.id] = m;
  });
  FIX_CACHE = { at: Date.now(), byId, season: d.season };
  return byId;
}
async function fixture(env, id) {
  return (await fixtures(env))[id] || null;
}
async function myMatches(env, r) {
  const byId = await fixtures(env);
  const t = today();
  const dayBefore = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const id in byId) {
    const m = byId[id];
    if (m.date !== t && m.date !== dayBefore)
      continue;
    const mine = r.role === "admin" || m.ref && r.ffk_name && m.ref.trim().toLowerCase() === r.ffk_name.trim().toLowerCase();
    if (!mine)
      continue;
    const st = await env.DB.prepare("SELECT * FROM match_state WHERE match_id = ?").bind(id).first();
    out.push({
      id,
      date: m.date,
      time: m.time,
      div: m.div,
      home: m.home,
      away: m.away,
      venue: m.venue || "",
      feedStatus: m.status,
      state: st ? shapeState(st) : null
    });
  }
  out.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  return out;
}
function shapeState(st) {
  return {
    status: st.status,
    minute: st.minute,
    hs: st.hs,
    as: st.as_,
    confirmed: !!st.confirmed,
    updatedAt: st.updated_at
  };
}
async function ensureState(env, matchId, r) {
  const st = await env.DB.prepare("SELECT * FROM match_state WHERE match_id = ?").bind(matchId).first();
  if (st)
    return st;
  await env.DB.prepare(
    "INSERT INTO match_state (match_id, status, minute, hs, as_, confirmed, by_ref, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(matchId, "sched", 0, 0, 0, 0, r.id, now()).run();
  return await env.DB.prepare("SELECT * FROM match_state WHERE match_id = ?").bind(matchId).first();
}
async function setStatus(env, r, matchId, status, body) {
  const st = await ensureState(env, matchId, r);
  if (st.confirmed)
    return bad("this match is already confirmed", 409);
  const minute = Number.isInteger(body.minute) ? body.minute : st.minute;
  await env.DB.prepare(
    "UPDATE match_state SET status = ?, minute = ?, by_ref = ?, updated_at = ? WHERE match_id = ?"
  ).bind(status, minute, r.id, now(), matchId).run();
  await audit(env, r.id, "match." + status, matchId, { minute });
  return json({ ok: true, state: shapeState({ ...st, status, minute, updated_at: now() }) });
}
async function addEvent(env, r, matchId, body) {
  const st = await ensureState(env, matchId, r);
  if (st.confirmed)
    return bad("this match is already confirmed", 409);
  const type = String(body.type || "");
  if (!["goal", "pen", "og", "yc", "rc"].includes(type))
    return bad("unknown event type");
  const team = String(body.team || "");
  if (!team)
    return bad("which team?");
  const min = Math.max(0, Math.min(130, parseInt(body.min, 10) || st.minute || 0));
  const player = String(body.player || "").slice(0, 60);
  const fx = await fixture(env, matchId);
  if (fx && team !== fx.home && team !== fx.away)
    return bad("that team is not in this match");
  const id = "e_" + token(8);
  await env.DB.prepare(
    "INSERT INTO events (id, match_id, min, type, team, player, by_ref, at, void) VALUES (?,?,?,?,?,?,?,?,0)"
  ).bind(id, matchId, min, type, team, player, r.id, now()).run();
  let hs = st.hs, as = st.as_;
  if (type === "goal" || type === "pen") {
    if (team === fx.home)
      hs++;
    else
      as++;
  } else if (type === "og") {
    if (team === fx.home)
      as++;
    else
      hs++;
  }
  await env.DB.prepare(
    "UPDATE match_state SET hs = ?, as_ = ?, minute = ?, status = CASE WHEN status = 'sched' THEN 'live' ELSE status END, by_ref = ?, updated_at = ? WHERE match_id = ?"
  ).bind(hs, as, min, r.id, now(), matchId).run();
  await audit(env, r.id, "event.add", matchId, { id, type, team, min, player });
  return json({ ok: true, eventId: id, hs, as });
}
async function undoEvent(env, r, matchId, body) {
  const st = await ensureState(env, matchId, r);
  if (st.confirmed)
    return bad("this match is already confirmed", 409);
  const id = String(body.eventId || "");
  const ev = await env.DB.prepare(
    "SELECT * FROM events WHERE id = ? AND match_id = ? AND void = 0"
  ).bind(id, matchId).first();
  if (!ev)
    return bad("event not found");
  await env.DB.prepare("UPDATE events SET void = 1 WHERE id = ?").bind(id).run();
  const fx = await fixture(env, matchId);
  let hs = st.hs, as = st.as_;
  if (ev.type === "goal" || ev.type === "pen") {
    if (ev.team === fx.home)
      hs = Math.max(0, hs - 1);
    else
      as = Math.max(0, as - 1);
  } else if (ev.type === "og") {
    if (ev.team === fx.home)
      as = Math.max(0, as - 1);
    else
      hs = Math.max(0, hs - 1);
  }
  await env.DB.prepare(
    "UPDATE match_state SET hs = ?, as_ = ?, by_ref = ?, updated_at = ? WHERE match_id = ?"
  ).bind(hs, as, r.id, now(), matchId).run();
  await audit(env, r.id, "event.undo", matchId, { id, type: ev.type });
  return json({ ok: true, hs, as });
}
async function setScore(env, r, matchId, body) {
  const st = await ensureState(env, matchId, r);
  if (st.confirmed && r.role !== "admin")
    return bad("this match is already confirmed", 409);
  const hs = Math.max(0, Math.min(30, parseInt(body.hs, 10) || 0));
  const as = Math.max(0, Math.min(30, parseInt(body.as, 10) || 0));
  await env.DB.prepare(
    "UPDATE match_state SET hs = ?, as_ = ?, by_ref = ?, updated_at = ? WHERE match_id = ?"
  ).bind(hs, as, r.id, now(), matchId).run();
  await audit(env, r.id, "match.score", matchId, { from: [st.hs, st.as_], to: [hs, as] });
  return json({ ok: true, hs, as });
}
async function confirmMatch(env, r, matchId, body) {
  const st = await ensureState(env, matchId, r);
  const fx = await fixture(env, matchId);
  const hs = Number.isInteger(body.hs) ? body.hs : st.hs;
  const as = Number.isInteger(body.as) ? body.as : st.as_;
  await env.DB.prepare(
    "UPDATE match_state SET status = ?, hs = ?, as_ = ?, confirmed = 1, by_ref = ?, updated_at = ? WHERE match_id = ?"
  ).bind("ft", hs, as, r.id, now(), matchId).run();
  const byId = await fixtures(env);
  const season = FIX_CACHE.season || String((/* @__PURE__ */ new Date()).getFullYear());
  await env.DB.prepare(
    "INSERT INTO results (match_id, hs, as_, season, kickoff, scored_at) VALUES (?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET hs = excluded.hs, as_ = excluded.as_, scored_at = excluded.scored_at"
  ).bind(matchId, hs, as, season, fx ? fx.date + "T" + (fx.time || "00:00") : null, now()).run();
  await audit(env, r.id, "match.confirm", matchId, { hs, as });
  await scoreMatch(env, matchId, hs, as, season);
  return json({ ok: true, confirmed: true, hs, as });
}
async function live(env) {
  const { results: states } = await env.DB.prepare(
    "SELECT * FROM match_state WHERE status IN ('live','ht') OR (confirmed = 1 AND updated_at > ?) ORDER BY updated_at DESC LIMIT 40"
  ).bind(new Date(Date.now() - 6 * 36e5).toISOString()).all();
  const ids = states.map((s) => s.match_id);
  let evs = [];
  if (ids.length) {
    const qs = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, match_id, min, type, team, player FROM events WHERE void = 0 AND match_id IN (${qs}) ORDER BY min`
    ).bind(...ids).all();
    evs = r.results;
  }
  const byMatch = {};
  evs.forEach((e) => {
    (byMatch[e.match_id] = byMatch[e.match_id] || []).push(e);
  });
  return json({
    at: now(),
    matches: states.map((s) => ({
      id: s.match_id,
      status: s.status,
      minute: s.minute,
      hs: s.hs,
      as: s.as_,
      confirmed: !!s.confirmed,
      updatedAt: s.updated_at,
      events: (byMatch[s.match_id] || []).map((e) => ({
        id: e.id,
        min: e.min,
        type: e.type,
        team: e.team,
        player: e.player || ""
      }))
    }))
  }, 200, { "cache-control": "no-store" });
}
async function googleAuth(env, body) {
  const cred = String(body.credential || "");
  if (!cred)
    return bad("missing credential");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred));
  if (!r.ok)
    return bad("sign in failed", 401);
  const t = await r.json();
  if (!t.sub)
    return bad("sign in failed", 401);
  if (env.GOOGLE_CLIENT_ID && t.aud !== env.GOOGLE_CLIENT_ID)
    return bad("wrong audience", 401);
  if (t.exp && parseInt(t.exp, 10) * 1e3 < Date.now())
    return bad("expired", 401);
  const name = (t.name || t.email || "Fan").slice(0, 40);
  let u = await env.DB.prepare("SELECT id FROM users WHERE sub = ?").bind(t.sub).first();
  if (!u) {
    const id = "u_" + token(8);
    await env.DB.prepare(
      "INSERT INTO users (id, sub, email, name, created_at) VALUES (?,?,?,?,?)"
    ).bind(id, t.sub, t.email || null, name, now()).run();
    u = { id };
  }
  const s = await newSession(env, "user", u.id);
  return json({ token: s.token, user: { id: u.id, name } });
}
async function meUser(req, env) {
  const u = await userFromSession(req, env);
  if (!u)
    return bad("not signed in", 401);
  return json({ user: u });
}
async function myPredictions(req, env, url) {
  const u = await userFromSession(req, env);
  if (!u)
    return bad("not signed in", 401);
  const { results } = await env.DB.prepare(
    "SELECT match_id, home, away FROM predictions WHERE user_id = ?"
  ).bind(u.id).all();
  const row = await env.DB.prepare(
    "SELECT pts, exact, outcome, played FROM standings_fan WHERE user_id = ? AND season = ?"
  ).bind(u.id, url.searchParams.get("season") || FIX_CACHE.season || "").first();
  return json({ predictions: results, score: row || { pts: 0, exact: 0, outcome: 0, played: 0 } });
}
async function savePrediction(req, env, body) {
  const u = await userFromSession(req, env);
  if (!u)
    return bad("not signed in", 401);
  const matchId = String(body.matchId || "");
  const home = parseInt(body.home, 10), away = parseInt(body.away, 10);
  if (!matchId || !(home >= 0 && home <= 30) || !(away >= 0 && away <= 30))
    return bad("bad prediction");
  const fx = await fixture(env, matchId);
  if (!fx)
    return bad("match not found");
  const ko = (/* @__PURE__ */ new Date(fx.date + "T" + (fx.time || "00:00") + ":00-04:00")).getTime();
  if (Date.now() >= ko)
    return bad("this match has already started", 409);
  const season = FIX_CACHE.season || String((/* @__PURE__ */ new Date()).getFullYear());
  await env.DB.prepare(
    "INSERT INTO predictions (user_id, match_id, home, away, season, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, match_id) DO UPDATE SET home = excluded.home, away = excluded.away, updated_at = excluded.updated_at"
  ).bind(u.id, matchId, home, away, season, now()).run();
  return json({ ok: true });
}
function points(pH, pA, aH, aA) {
  if (pH === aH && pA === aA)
    return 3;
  const pr = Math.sign(pH - pA), ar = Math.sign(aH - aA);
  return pr === ar ? 1 : 0;
}
async function scoreMatch(env, matchId, hs, as, season) {
  const { results } = await env.DB.prepare(
    "SELECT user_id, home, away FROM predictions WHERE match_id = ?"
  ).bind(matchId).all();
  if (!results.length)
    return;
  const stmts = results.map((p) => {
    const pts = points(p.home, p.away, hs, as);
    return env.DB.prepare(
      "INSERT INTO standings_fan (season, user_id, pts, exact, outcome, played) VALUES (?,?,?,?,?,1) ON CONFLICT(season, user_id) DO UPDATE SET pts = pts + ?, exact = exact + ?, outcome = outcome + ?, played = played + 1"
    ).bind(
      season,
      p.user_id,
      pts,
      pts === 3 ? 1 : 0,
      pts === 1 ? 1 : 0,
      pts,
      pts === 3 ? 1 : 0,
      pts === 1 ? 1 : 0
    );
  });
  await env.DB.batch(stmts);
}
async function leaderboard(req, env, url) {
  const season = url.searchParams.get("season") || FIX_CACHE.season || "";
  const limit = Math.min(100, parseInt(url.searchParams.get("limit"), 10) || 25);
  const { results } = await env.DB.prepare(
    "SELECT s.user_id, u.name, s.pts, s.exact, s.outcome, s.played FROM standings_fan s JOIN users u ON u.id = s.user_id WHERE s.season = ? ORDER BY s.pts DESC, s.exact DESC, s.played ASC LIMIT ?"
  ).bind(season, limit).all();
  let me = null;
  const u = await userFromSession(req, env);
  if (u) {
    const row = await env.DB.prepare(
      "SELECT pts, exact, outcome, played FROM standings_fan WHERE season = ? AND user_id = ?"
    ).bind(season, u.id).first();
    if (row) {
      const ahead = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM standings_fan WHERE season = ? AND (pts > ? OR (pts = ? AND exact > ?))"
      ).bind(season, row.pts, row.pts, row.exact).first();
      me = { ...row, rank: (ahead ? ahead.n : 0) + 1, name: u.name };
    } else {
      me = { pts: 0, exact: 0, outcome: 0, played: 0, rank: null, name: u.name };
    }
  }
  return json({ season, rows: results, me }, 200, { "cache-control": "public, max-age=30" });
}
async function adminRoute(p, req, env, body, POST) {
  const key = !!env.ADMIN_KEY && req.headers.get("authorization") === "Bearer " + env.ADMIN_KEY;
  let r = null;
  if (!key) {
    try {
      r = await refFromSession(req, env);
    } catch (e) {
      r = null;
    }
  }
  const isAdmin = key || r && r.role === "admin";
  if (!isAdmin)
    return bad("admin only", 403);
  const who = r ? r.id : "adminkey";
  if (p === "/admin/referees" && !POST) {
    const { results } = await env.DB.prepare(
      "SELECT id, name, ffk_name, phone, area, role, active, invite, (pin_hash IS NOT NULL) AS claimed FROM referees ORDER BY name"
    ).all();
    return json({ referees: results });
  }
  if (p === "/admin/referees" && POST) {
    const name = String(body.name || "").trim();
    const ffk = String(body.ffkName || name).trim();
    if (!name)
      return bad("name required");
    const id = String(body.id || "r_" + token(5));
    const code = inviteCode();
    await env.DB.prepare(
      "INSERT INTO referees (id, name, ffk_name, phone, area, role, invite, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)"
    ).bind(
      id,
      name,
      ffk,
      body.phone || null,
      body.area || null,
      body.role === "admin" ? "admin" : "ref",
      code,
      now()
    ).run();
    await audit(env, who, "ref.create", null, { id, name });
    return json({ ok: true, id, invite: code });
  }
  if (p === "/admin/referees/reset" && POST) {
    const id = String(body.id || "");
    const code = inviteCode();
    const res = await env.DB.prepare(
      "UPDATE referees SET invite = ?, pin_hash = NULL WHERE id = ?"
    ).bind(code, id).run();
    if (!res.meta.changes)
      return bad("no such referee", 404);
    await env.DB.prepare("DELETE FROM sessions WHERE kind = ? AND subject = ?").bind("ref", id).run();
    await audit(env, who, "ref.reset", null, { id });
    return json({ ok: true, invite: code });
  }
  if (p === "/admin/migrate" && POST) {
    const done = [];
    for (const sql of SCHEMA) {
      await env.DB.prepare(sql).run();
      done.push(sql.slice(0, 48).replace(/\s+/g, " "));
    }
    const t = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();
    try {
      await audit(env, who, "migrate", null, { statements: SCHEMA.length });
    } catch (e) {
    }
    return json({ ok: true, ran: done.length, tables: t.results.map((r2) => r2.name) });
  }
  if (p === "/admin/audit") {
    const { results } = await env.DB.prepare(
      "SELECT at, who, kind, match_id, detail FROM audit ORDER BY id DESC LIMIT 200"
    ).all();
    return json({ audit: results });
  }
  return bad("not found", 404);
}
export {
  src_default as default,
  points
};
