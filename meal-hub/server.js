'use strict';
// OHNEZ MEAL Hub — zero-dependency server (Node 22+: node:http + node:sqlite).
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Session secret: env var, else generated once and kept on the volume.
const secretFile = path.join(DATA_DIR, '.session_secret');
const SECRET = process.env.SESSION_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') :
  (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, s, { mode: 0o600 }); return s; })());

const db = new DatabaseSync(path.join(DATA_DIR, 'hub.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer');
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT, type TEXT, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
`);

// ---------- auth ----------
function hash(pw, salt = crypto.randomBytes(16).toString('hex')) { return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function check(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function unsign(s) { if (!s) return null; const i = s.lastIndexOf('.'); if (i < 0) return null; const v = s.slice(0, i); const a = Buffer.from(sign(v)), b = Buffer.from(s); return a.length === b.length && crypto.timingSafeEqual(a, b) ? v : null; }
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
const qUserById = db.prepare('SELECT id,username,name,role FROM users WHERE id=?');
function currentUser(req) {
  const v = unsign(cookies(req).hub_sess); if (!v) return null;
  const [id, exp] = v.split('|'); if (Date.now() > Number(exp)) return null;
  const u = qUserById.get(Number(id)); return u ? Object.assign({}, u) : null;
}
const canWrite = u => !!u && (u.role === 'admin' || u.role === 'editor');

if (db.prepare('SELECT count(*) n FROM users').get().n === 0 && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
  db.prepare('INSERT INTO users(username,name,pass_hash,role) VALUES(?,?,?,?)').run(process.env.ADMIN_USER.toLowerCase(), process.env.ADMIN_NAME || process.env.ADMIN_USER, hash(process.env.ADMIN_PASSWORD), 'admin');
  console.log('Created admin user', process.env.ADMIN_USER);
}

// ---------- doc helpers ----------
const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
function validPath(p, wantDoc) {
  const segs = String(p || '').split('/');
  return segs.length > 0 && segs.length <= 16 && segs.every(s => SEG.test(s) && s !== '.' && s !== '..') && wantDoc === (segs.length % 2 === 0);
}
const collOf = p => p.split('/').slice(0, -1).join('/');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) { const out = Object.assign({}, a); for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v; return out; }
const now = () => new Date().toISOString();
const qGet = db.prepare('SELECT data FROM docs WHERE path=?');
const qPut = db.prepare('INSERT INTO docs(path,coll,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at');
const qDel = db.prepare('DELETE FROM docs WHERE path=?');
const qColl = db.prepare('SELECT path,data FROM docs WHERE coll=?');

// realtime (Server-Sent Events)
const clients = new Set();
function broadcast(paths) { const m = `data: ${JSON.stringify(paths)}\n\n`; for (const c of clients) c.write(m); }

function cmp(a, b) { if (a === b) return 0; if (a === undefined || a === null) return 1; if (b === undefined || b === null) return -1; return a < b ? -1 : 1; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OPS = { '==': eq, '!=': (a, b) => !eq(a, b), '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  in: (a, b) => Array.isArray(b) && b.some(x => eq(x, a)), 'not-in': (a, b) => Array.isArray(b) && !b.some(x => eq(x, a)),
  'array-contains': (a, b) => Array.isArray(a) && a.some(x => eq(x, b)) };

// ---------- http plumbing ----------
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function json(req) { const b = await readBody(req, 60 * 1024 * 1024); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('Bad JSON'), { status: 400 }); } }
const pub = path.join(__dirname, 'public');
const pages = {};
function page(res, name) {
  if (!pages[name] || process.env.NODE_ENV !== 'production') pages[name] = fs.readFileSync(path.join(pub, name));
  const type = name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(pages[name]);
}
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const user = currentUser(req);
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (p === '/healthz') return send(res, 200, 'ok');
  if (p === '/login' && m === 'GET') return page(res, 'login.html');
  if (p === '/shim.js') return page(res, 'shim.js');
  if (p === '/' && m === 'GET') return user ? page(res, 'app.html') : redirect(res, '/login');
  if (p === '/admin' && m === 'GET') return user && user.role === 'admin' ? page(res, 'admin.html') : redirect(res, user ? '/' : '/login');

  if (p === '/api/login' && m === 'POST') {
    const { username, password } = await json(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').toLowerCase().trim());
    if (!u || !check(String(password || ''), u.pass_hash)) { await new Promise(r => setTimeout(r, 400)); return send(res, 401, { error: 'Wrong username or password' }); }
    const days = 14, tok = sign(u.id + '|' + (Date.now() + days * 864e5));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `hub_sess=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure ? '; Secure' : ''}` });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'hub_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });

  if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
  if (!user) return send(res, 401, { error: 'Sign in required' });
  const admin = user.role === 'admin';
  const needWrite = () => canWrite(user) ? null : send(res, 403, { error: 'Read-only account' });
  const needAdmin = () => admin ? null : send(res, 403, { error: 'Admins only' });

  if (p === '/api/me' && m === 'GET') return send(res, 200, user);
  if (p === '/api/me/password' && m === 'POST') {
    const { current, next } = await json(req);
    const row = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(user.id);
    if (!check(String(current || ''), row.pass_hash)) return send(res, 400, { error: 'Current password is wrong' });
    if (!next || String(next).length < 8) return send(res, 400, { error: 'New password needs at least 8 characters' });
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash(String(next)), user.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/profiles' && m === 'GET') {
    const out = {};
    for (const id of String(url.searchParams.get('ids') || '').split(',').map(Number).filter(Boolean)) { const u = qUserById.get(id); if (u) out[String(u.id)] = { name: u.name }; }
    return send(res, 200, out);
  }

  // users (admin)
  if (p === '/api/users' && m === 'GET') return needAdmin() || send(res, 200, db.prepare('SELECT id,username,name,role FROM users ORDER BY id').all());
  if (p === '/api/users' && m === 'POST') {
    if (needAdmin()) return;
    const { id, username, name, password, role } = await json(req);
    if (!['admin', 'editor', 'viewer'].includes(role)) return send(res, 400, { error: 'Bad role' });
    try {
      if (id) {
        if (Number(id) === user.id && role !== 'admin') return send(res, 400, { error: "You can't remove your own admin role" });
        if (password && String(password).length < 8) return send(res, 400, { error: 'Password needs at least 8 characters' });
        db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(String(name || ''), role, Number(id));
        if (password) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash(String(password)), Number(id));
      } else {
        if (!username || !password || String(password).length < 8) return send(res, 400, { error: 'Username and a password of 8+ characters are required' });
        db.prepare('INSERT INTO users(username,name,pass_hash,role) VALUES(?,?,?,?)').run(String(username).toLowerCase().trim(), String(name || username), hash(String(password)), role);
      }
    } catch (e) { return send(res, 400, { error: /UNIQUE/.test(e.message) ? 'That username is taken' : e.message }); }
    return send(res, 200, { ok: true });
  }
  const um = p.match(/^\/api\/users\/(\d+)$/);
  if (um && m === 'DELETE') {
    if (needAdmin()) return;
    if (Number(um[1]) === user.id) return send(res, 400, { error: "You can't remove yourself" });
    db.prepare('DELETE FROM users WHERE id=?').run(Number(um[1]));
    return send(res, 200, { ok: true });
  }

  // realtime feed
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hi\n\n'); clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // document store
  if (p === '/api/doc') {
    if (m === 'GET') {
      const dp = url.searchParams.get('path'); if (!validPath(dp, true)) return send(res, 400, { error: 'Bad path' });
      const r = qGet.get(dp); return send(res, 200, r ? { exists: true, data: JSON.parse(r.data) } : { exists: false });
    }
    if (m === 'DELETE') {
      if (needWrite()) return;
      const dp = url.searchParams.get('path'); if (!validPath(dp, true)) return send(res, 400, { error: 'Bad path' });
      qDel.run(dp); broadcast([dp]); return send(res, 200, { ok: true });
    }
    if (m === 'PUT' || m === 'PATCH') {
      if (needWrite()) return;
      const { path: dp, data } = await json(req);
      if (!validPath(dp, true)) return send(res, 400, { error: 'Bad path' });
      if (!isObj(data)) return send(res, 400, { error: 'Body must be an object' });
      let body = data;
      if (m === 'PATCH') { const r = qGet.get(dp); if (!r) return send(res, 400, { error: 'Document does not exist', code: 'invalid_argument' }); body = merge(JSON.parse(r.data), data); }
      const s = JSON.stringify(body); if (s.length > 1024 * 1024) return send(res, 400, { error: 'Document too large' });
      qPut.run(dp, collOf(dp), s, now()); broadcast([dp]); return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/query' && m === 'POST') {
    const { coll, where = [], orderBy, dir = 'asc', limit } = await json(req);
    if (!validPath(coll, false)) return send(res, 400, { error: 'Bad path' });
    let docs = qColl.all(coll).map(r => ({ id: r.path.split('/').pop(), data: JSON.parse(r.data) }));
    for (const w of where) { const f = OPS[w.op]; if (!f) return send(res, 400, { error: 'Bad operator' }); docs = docs.filter(d => d.data[w.field] !== undefined && f(d.data[w.field], w.value)); }
    if (orderBy) docs.sort((x, y) => cmp(x.data[orderBy], y.data[orderBy]) * (dir === 'desc' ? -1 : 1));
    else docs.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (limit) docs = docs.slice(0, Number(limit));
    return send(res, 200, { docs });
  }

  // import / backup (admin)
  if (p === '/api/import' && m === 'POST') {
    if (needAdmin()) return;
    const body = await json(req); const docs = body.docs;
    if (!Array.isArray(docs) || !docs.length) return send(res, 400, { error: 'No records in file' });
    if (docs.some(d => !d || !validPath(d.path, true) || !isObj(d.data))) return send(res, 400, { error: 'File has an invalid record' });
    db.exec('BEGIN');
    try { if (body.replace) db.exec('DELETE FROM docs'); for (const d of docs) qPut.run(d.path, collOf(d.path), JSON.stringify(d.data), now()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); return send(res, 400, { error: e.message }); }
    broadcast(['*']); return send(res, 200, { ok: true, imported: docs.length });
  }
  if (p === '/api/export' && m === 'GET') {
    if (needAdmin()) return;
    const docs = db.prepare('SELECT path,data FROM docs ORDER BY path').all().map(r => ({ path: r.path, data: JSON.parse(r.data) }));
    return send(res, 200, { exportedAt: now(), docs }, { 'Content-Disposition': `attachment; filename="OHNEZ_MEAL_Hub_backup_${now().slice(0, 10)}.json"` });
  }

  // file assets
  if (p === '/api/assets' && m === 'POST') {
    if (needWrite()) return;
    const bytes = await readBody(req, 25 * 1024 * 1024);
    const id = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO assets(id,name,type,bytes,created_at) VALUES(?,?,?,?,?)').run(id, String(url.searchParams.get('name') || 'file').slice(0, 200), String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100), bytes, now());
    return send(res, 200, { id, url: '/api/assets/' + id });
  }
  const am = p.match(/^\/api\/assets\/([a-f0-9]+)$/);
  if (am && m === 'GET') {
    const r = db.prepare('SELECT name,type,bytes FROM assets WHERE id=?').get(am[1]);
    if (!r) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': r.type, 'Content-Disposition': `attachment; filename="${String(r.name).replace(/[^\w.\- ]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff' });
    return res.end(Buffer.from(r.bytes));
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }); });
}).listen(PORT, () => console.log('OHNEZ MEAL Hub listening on', PORT, 'data in', DATA_DIR));
