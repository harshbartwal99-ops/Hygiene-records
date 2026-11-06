'use strict';
// Hygiene Records - zero-dependency Node server (Node 22+, built-in SQLite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'hygiene.db');
const PUBLIC_DIR = __dirname;
// Flat layout: only these files may be served to browsers (never server.js, the database, etc.)
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']);
const DEFAULT_TZ = process.env.TZ_DEFAULT || 'Europe/London';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, tz TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','staff')), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS equipment(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL, kind TEXT NOT NULL, min_temp REAL NOT NULL, max_temp REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS temp_logs(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  equipment_name TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL,
  temp REAL NOT NULL, min_temp REAL NOT NULL, max_temp REAL NOT NULL, in_range INTEGER NOT NULL,
  corrective_action TEXT, note TEXT, log_date TEXT NOT NULL, logged_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_temp_site_date ON temp_logs(site_id, log_date);
CREATE TABLE IF NOT EXISTS checklists(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS checklist_items(
  id INTEGER PRIMARY KEY, checklist_id INTEGER NOT NULL REFERENCES checklists(id),
  text TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, checklist_id INTEGER NOT NULL REFERENCES checklists(id),
  checklist_name TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL,
  run_date TEXT NOT NULL, completed_at TEXT NOT NULL, comment TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_site_date ON runs(site_id, run_date);
CREATE TABLE IF NOT EXISTS run_items(
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
  text TEXT NOT NULL, checked INTEGER NOT NULL, note TEXT);
`);

// ---------- helpers ----------
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const exec = (sql, ...p) => { const r = db.prepare(sql).run(...p); return Number(r.lastInsertRowid); };
const now = () => new Date().toISOString();
const dateIn = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

const str = (v, name, { max = 200, required = true } = {}) => {
  if (v == null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const s = v.trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long`);
  return s || null;
};
const num = (v, name) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${name} must be a number`);
  return n;
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  exec('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, userId,
    new Date(Date.now() + 30 * 864e5).toISOString());
  return token;
}
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// Crude in-memory login throttle (per IP+email).
const attempts = new Map();
function throttle(key) {
  const t = Date.now();
  const rec = (attempts.get(key) || []).filter((x) => t - x < 15 * 60e3);
  if (rec.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  rec.push(t); attempts.set(key, rec);
}

function seedSite(siteId) {
  const eq = [
    ['Walk-in fridge', 'fridge', 0, 5], ['Prep fridge', 'fridge', 0, 5],
    ['Freezer', 'freezer', -25, -18], ['Hot hold / bain-marie', 'hot_hold', 63, 90],
  ];
  for (const [n, k, lo, hi] of eq) exec('INSERT INTO equipment(site_id,name,kind,min_temp,max_temp) VALUES(?,?,?,?,?)', siteId, n, k, lo, hi);
  const lists = [
    ['Opening checks', 'daily', ['Handwash basins stocked with soap, paper towels and hot water', 'Work surfaces and chopping boards clean and sanitised', 'Probe thermometer clean and working', 'Pest check: no signs of pests', 'Staff in clean uniform, hair tied back, no illness reported', 'Allergen information up to date']],
    ['Closing checks', 'daily', ['All food covered, labelled and dated', 'Leftover food discarded or cooled and stored correctly', 'Floors swept and mopped', 'Surfaces, equipment and sinks cleaned and sanitised', 'Bins emptied and bin area clean', 'Fridges and freezers closed and running']],
    ['Weekly deep clean', 'weekly', ['Fridge and freezer interiors cleaned', 'Extraction filters and canopy cleaned', 'Oven, fryer and grill deep cleaned', 'Walls, ceilings and light fittings checked', 'Drains cleaned', 'Cleaning chemicals stocked and stored away from food']],
  ];
  for (const [name, freq, items] of lists) {
    const id = exec('INSERT INTO checklists(site_id,name,frequency) VALUES(?,?,?)', siteId, name, freq);
    items.forEach((t, i) => exec('INSERT INTO checklist_items(checklist_id,text,position) VALUES(?,?,?)', id, t, i));
  }
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, owner: !!opts.owner });
};
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active });

route('POST', '/api/auth/register', { auth: false }, (ctx) => {
  const b = ctx.body;
  const business = str(b.business, 'Business name', { max: 120 });
  const name = str(b.name, 'Your name', { max: 80 });
  if (!validEmail(b.email)) throw bad('Enter a valid email');
  if (typeof b.password !== 'string' || b.password.length < 8) throw bad('Password must be at least 8 characters');
  const email = b.email.trim().toLowerCase();
  if (get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with that email already exists');
  return tx(() => {
    const siteId = exec('INSERT INTO sites(name,tz,created_at) VALUES(?,?,?)', business, DEFAULT_TZ, now());
    const uid = exec('INSERT INTO users(site_id,name,email,pw_hash,role,created_at) VALUES(?,?,?,?,?,?)', siteId, name, email, hashPassword(b.password), 'owner', now());
    seedSite(siteId);
    return { token: newSession(uid) };
  });
});

route('POST', '/api/auth/login', { auth: false }, (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  throttle(`${ctx.ip}|${email}`);
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (!u || !u.active || typeof ctx.body.password !== 'string' || !checkPassword(ctx.body.password, u.pw_hash)) throw new HttpError(401, 'Incorrect email or password');
  return { token: newSession(u.id) };
});

route('POST', '/api/auth/logout', (ctx) => { exec('DELETE FROM sessions WHERE token=?', ctx.token); return { ok: true }; });

route('GET', '/api/me', (ctx) => {
  const site = get('SELECT id,name,tz FROM sites WHERE id=?', ctx.user.site_id);
  return { user: publicUser(ctx.user), site, today: dateIn(site.tz) };
});

// Equipment
route('GET', '/api/equipment', (ctx) => all('SELECT id,name,kind,min_temp,max_temp,active FROM equipment WHERE site_id=? ORDER BY active DESC, id', ctx.user.site_id));
const KINDS = ['fridge', 'freezer', 'hot_hold', 'cold_display', 'delivery', 'other'];
function equipmentFields(b) {
  const kind = str(b.kind, 'Type', { max: 30 });
  if (!KINDS.includes(kind)) throw bad('Unknown equipment type');
  const min = num(b.min_temp, 'Minimum temperature'), max = num(b.max_temp, 'Maximum temperature');
  if (min > max) throw bad('Minimum must not be above maximum');
  return { name: str(b.name, 'Name', { max: 80 }), kind, min, max };
}
route('POST', '/api/equipment', { owner: true }, (ctx) => {
  const f = equipmentFields(ctx.body);
  return { id: exec('INSERT INTO equipment(site_id,name,kind,min_temp,max_temp) VALUES(?,?,?,?,?)', ctx.user.site_id, f.name, f.kind, f.min, f.max) };
});
route('PUT', '/api/equipment/:id', { owner: true }, (ctx) => {
  const e = get('SELECT * FROM equipment WHERE id=? AND site_id=?', ctx.params.id, ctx.user.site_id);
  if (!e) throw new HttpError(404, 'Not found');
  const f = equipmentFields({ ...e, ...ctx.body });
  const active = ctx.body.active === undefined ? e.active : (ctx.body.active ? 1 : 0);
  exec('UPDATE equipment SET name=?,kind=?,min_temp=?,max_temp=?,active=? WHERE id=?', f.name, f.kind, f.min, f.max, active, e.id);
  return { ok: true };
});

// Temperature logs (append-only: records are never edited or deleted)
route('GET', '/api/temps', (ctx) => {
  const { from, to, equipment_id } = ctx.query;
  const where = ['site_id=?'], p = [ctx.user.site_id];
  if (from) { if (!isDate(from)) throw bad('Bad from date'); where.push('log_date>=?'); p.push(from); }
  if (to) { if (!isDate(to)) throw bad('Bad to date'); where.push('log_date<=?'); p.push(to); }
  if (equipment_id) { where.push('equipment_id=?'); p.push(Number(equipment_id)); }
  const limit = Math.min(Number(ctx.query.limit) || 100, 1000);
  return all(`SELECT * FROM temp_logs WHERE ${where.join(' AND ')} ORDER BY logged_at DESC LIMIT ${limit}`, ...p);
});
route('POST', '/api/temps', (ctx) => {
  const b = ctx.body;
  const e = get('SELECT * FROM equipment WHERE id=? AND site_id=? AND active=1', Number(b.equipment_id), ctx.user.site_id);
  if (!e) throw bad('Unknown equipment');
  const temp = num(b.temp, 'Temperature');
  if (temp < -60 || temp > 300) throw bad('That temperature looks wrong. Please check the reading.');
  const inRange = temp >= e.min_temp && temp <= e.max_temp ? 1 : 0;
  const action = str(b.corrective_action, 'Corrective action', { max: 300, required: !inRange });
  const site = get('SELECT tz FROM sites WHERE id=?', ctx.user.site_id);
  const id = exec(`INSERT INTO temp_logs(site_id,equipment_id,equipment_name,user_id,user_name,temp,min_temp,max_temp,in_range,corrective_action,note,log_date,logged_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ctx.user.site_id, e.id, e.name, ctx.user.id, ctx.user.name, temp, e.min_temp, e.max_temp, inRange,
    inRange ? null : action, str(b.note, 'Note', { max: 300, required: false }), dateIn(site.tz), now());
  return { id, in_range: !!inRange };
});

// Checklists
const listWithItems = (siteId, onlyActive) => all(`SELECT id,name,frequency,active FROM checklists WHERE site_id=? ${onlyActive ? 'AND active=1' : ''} ORDER BY active DESC, id`, siteId)
  .map((c) => ({ ...c, items: all('SELECT id,text FROM checklist_items WHERE checklist_id=? ORDER BY position,id', c.id) }));
route('GET', '/api/checklists', (ctx) => listWithItems(ctx.user.site_id, ctx.query.all !== '1'));
function checklistFields(b) {
  const frequency = str(b.frequency, 'Frequency', { max: 10 });
  if (!['daily', 'weekly'].includes(frequency)) throw bad('Frequency must be daily or weekly');
  if (!Array.isArray(b.items)) throw bad('Items are required');
  const items = b.items.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  if (!items.length) throw bad('Add at least one item');
  if (items.length > 60 || items.some((t) => t.length > 200)) throw bad('Too many or too long items');
  return { name: str(b.name, 'Name', { max: 80 }), frequency, items };
}
const setItems = (id, items) => { exec('DELETE FROM checklist_items WHERE checklist_id=?', id); items.forEach((t, i) => exec('INSERT INTO checklist_items(checklist_id,text,position) VALUES(?,?,?)', id, t, i)); };
route('POST', '/api/checklists', { owner: true }, (ctx) => {
  const f = checklistFields(ctx.body);
  return tx(() => { const id = exec('INSERT INTO checklists(site_id,name,frequency) VALUES(?,?,?)', ctx.user.site_id, f.name, f.frequency); setItems(id, f.items); return { id }; });
});
route('PUT', '/api/checklists/:id', { owner: true }, (ctx) => {
  const c = get('SELECT * FROM checklists WHERE id=? AND site_id=?', ctx.params.id, ctx.user.site_id);
  if (!c) throw new HttpError(404, 'Not found');
  const f = checklistFields(ctx.body);
  const active = ctx.body.active === undefined ? c.active : (ctx.body.active ? 1 : 0);
  return tx(() => { exec('UPDATE checklists SET name=?,frequency=?,active=? WHERE id=?', f.name, f.frequency, active, c.id); setItems(c.id, f.items); return { ok: true }; });
});

// Completed checklist runs (append-only)
route('POST', '/api/runs', (ctx) => {
  const b = ctx.body;
  const c = get('SELECT * FROM checklists WHERE id=? AND site_id=? AND active=1', Number(b.checklist_id), ctx.user.site_id);
  if (!c) throw bad('Unknown checklist');
  const items = all('SELECT id,text FROM checklist_items WHERE checklist_id=? ORDER BY position,id', c.id);
  const sub = new Map((Array.isArray(b.items) ? b.items : []).map((i) => [Number(i.item_id), i]));
  const rows = items.map((it) => {
    const s = sub.get(it.id) || {};
    const checked = s.checked ? 1 : 0;
    const note = str(s.note, 'Note', { max: 300, required: false });
    if (!checked && !note) throw bad(`Tick or add a note for: ${it.text}`);
    return { text: it.text, checked, note };
  });
  const site = get('SELECT tz FROM sites WHERE id=?', ctx.user.site_id);
  return tx(() => {
    const id = exec('INSERT INTO runs(site_id,checklist_id,checklist_name,user_id,user_name,run_date,completed_at,comment) VALUES(?,?,?,?,?,?,?,?)',
      ctx.user.site_id, c.id, c.name, ctx.user.id, ctx.user.name, dateIn(site.tz), now(), str(b.comment, 'Comment', { max: 500, required: false }));
    rows.forEach((r) => exec('INSERT INTO run_items(run_id,text,checked,note) VALUES(?,?,?,?)', id, r.text, r.checked, r.note));
    return { id };
  });
});
function runsBetween(siteId, from, to, limit = 500) {
  const runs = all('SELECT * FROM runs WHERE site_id=? AND run_date>=? AND run_date<=? ORDER BY completed_at DESC LIMIT ?', siteId, from, to, limit);
  return runs.map((r) => ({ ...r, items: all('SELECT text,checked,note FROM run_items WHERE run_id=? ORDER BY id', r.id) }));
}
function range(q, site) {
  const today = dateIn(site.tz);
  const to = q.to || today;
  const from = q.from || dateIn(site.tz, new Date(Date.now() - 6 * 864e5));
  if (!isDate(from) || !isDate(to)) throw bad('Dates must be YYYY-MM-DD');
  if (from > to) throw bad('From date must be before to date');
  return { from, to };
}
route('GET', '/api/runs', (ctx) => {
  const site = get('SELECT * FROM sites WHERE id=?', ctx.user.site_id);
  const { from, to } = range(ctx.query, site);
  return runsBetween(ctx.user.site_id, from, to, 100);
});

// Dashboard
route('GET', '/api/dashboard', (ctx) => {
  const site = get('SELECT * FROM sites WHERE id=?', ctx.user.site_id);
  const today = dateIn(site.tz);
  const weekStart = dateIn(site.tz, new Date(Date.now() - 6 * 864e5));
  const equipment = all('SELECT id,name,kind,min_temp,max_temp FROM equipment WHERE site_id=? AND active=1 ORDER BY id', site.id).map((e) => {
    const logs = all('SELECT id,temp,in_range,logged_at,user_name,corrective_action FROM temp_logs WHERE equipment_id=? AND log_date=? ORDER BY logged_at DESC', e.id, today);
    const last = logs[0] || null;
    return { ...e, today_count: logs.length, last, status: !last ? 'due' : last.in_range ? 'ok' : 'alert' };
  });
  const checklists = all('SELECT id,name,frequency FROM checklists WHERE site_id=? AND active=1 ORDER BY id', site.id).map((c) => {
    const since = c.frequency === 'weekly' ? weekStart : today;
    const last = get('SELECT id,user_name,completed_at,run_date FROM runs WHERE checklist_id=? AND run_date>=? ORDER BY completed_at DESC LIMIT 1', c.id, since);
    return { ...c, done: !!last, last };
  });
  const alerts = all('SELECT id,equipment_name,temp,min_temp,max_temp,corrective_action,user_name,logged_at FROM temp_logs WHERE site_id=? AND log_date=? AND in_range=0 ORDER BY logged_at DESC', site.id, today);
  return { today, equipment, checklists, alerts };
});

// Reports
route('GET', '/api/report', (ctx) => {
  const site = get('SELECT * FROM sites WHERE id=?', ctx.user.site_id);
  const { from, to } = range(ctx.query, site);
  const temps = all('SELECT * FROM temp_logs WHERE site_id=? AND log_date>=? AND log_date<=? ORDER BY logged_at', site.id, from, to);
  const runs = runsBetween(site.id, from, to);
  return {
    site: site.name, from, to, generated_at: now(),
    summary: { temp_checks: temps.length, out_of_range: temps.filter((t) => !t.in_range).length, checklists_completed: runs.length, items_flagged: runs.reduce((n, r) => n + r.items.filter((i) => !i.checked).length, 0) },
    temps, runs,
  };
});
const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
route('GET', '/api/export/temps.csv', (ctx) => {
  const site = get('SELECT * FROM sites WHERE id=?', ctx.user.site_id);
  const { from, to } = range(ctx.query, site);
  const rows = all('SELECT * FROM temp_logs WHERE site_id=? AND log_date>=? AND log_date<=? ORDER BY logged_at', site.id, from, to);
  return { csv: toCsv(['Date', 'Time (UTC)', 'Equipment', 'Temp C', 'Min', 'Max', 'In range', 'Corrective action', 'Note', 'Logged by'],
    rows.map((t) => [t.log_date, t.logged_at.slice(11, 19), t.equipment_name, t.temp, t.min_temp, t.max_temp, t.in_range ? 'Yes' : 'NO', t.corrective_action, t.note, t.user_name])), name: `temperatures_${from}_${to}.csv` };
});
route('GET', '/api/export/checklists.csv', (ctx) => {
  const site = get('SELECT * FROM sites WHERE id=?', ctx.user.site_id);
  const { from, to } = range(ctx.query, site);
  const rows = [];
  for (const r of runsBetween(site.id, from, to, 5000)) for (const i of r.items) rows.push([r.run_date, r.completed_at.slice(11, 19), r.checklist_name, i.text, i.checked ? 'Yes' : 'NO', i.note, r.user_name, r.comment]);
  return { csv: toCsv(['Date', 'Time (UTC)', 'Checklist', 'Item', 'Done', 'Note', 'Signed off by', 'Comment'], rows), name: `checklists_${from}_${to}.csv` };
});

// Staff
route('GET', '/api/staff', { owner: true }, (ctx) => all('SELECT id,name,email,role,active FROM users WHERE site_id=? ORDER BY id', ctx.user.site_id).map((u) => ({ ...u, active: !!u.active })));
route('POST', '/api/staff', { owner: true }, (ctx) => {
  const b = ctx.body;
  const name = str(b.name, 'Name', { max: 80 });
  if (!validEmail(b.email)) throw bad('Enter a valid email');
  if (typeof b.password !== 'string' || b.password.length < 8) throw bad('Password must be at least 8 characters');
  const email = b.email.trim().toLowerCase();
  if (get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'That email is already in use');
  return { id: exec('INSERT INTO users(site_id,name,email,pw_hash,role,created_at) VALUES(?,?,?,?,?,?)', ctx.user.site_id, name, email, hashPassword(b.password), 'staff', now()) };
});
route('PUT', '/api/staff/:id', { owner: true }, (ctx) => {
  const u = get('SELECT * FROM users WHERE id=? AND site_id=?', ctx.params.id, ctx.user.site_id);
  if (!u) throw new HttpError(404, 'Not found');
  if (u.id === ctx.user.id) throw bad("You can't deactivate your own account");
  exec('UPDATE users SET active=? WHERE id=?', ctx.body.active ? 1 : 0, u.id);
  if (!ctx.body.active) exec('DELETE FROM sessions WHERE user_id=?', u.id);
  return { ok: true };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...headers });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100e3) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(bad('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const name = rel.replace(/^\//, '');
  if (!PUBLIC_FILES.has(name)) return send(res, 404, 'Not found');
  const file = path.join(PUBLIC_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300', ...SEC });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    let matched = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!matched) return send(res, 404, { error: 'Not found' });
    const ctx = { params, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress, body: {}, user: null, token: null };
    if (matched.auth) {
      const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || '');
      const s = m && get('SELECT * FROM sessions WHERE token=?', m[1]);
      const u = s && s.expires_at > now() && get('SELECT * FROM users WHERE id=? AND active=1', s.user_id);
      if (!u) return send(res, 401, { error: 'Please sign in' });
      ctx.user = u; ctx.token = m[1];
      if (matched.owner && u.role !== 'owner') return send(res, 403, { error: 'Owner access required' });
    }
    if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
    const out = matched.handler(ctx);
    if (out && out.csv !== undefined) return send(res, 200, out.csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"` });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong' });
  }
});

if (require.main === module) {
  exec('DELETE FROM sessions WHERE expires_at<?', now());
  server.listen(PORT, () => console.log(`Hygiene Records running on http://localhost:${PORT}`));
}
module.exports = { server, db };
