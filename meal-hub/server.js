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
  CREATE TABLE IF NOT EXISTS deleted (path TEXT PRIMARY KEY, coll TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS docs_upd ON docs(updated_at);
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
const qTombDel = db.prepare('DELETE FROM deleted WHERE path=?');
const qTomb = db.prepare('INSERT INTO deleted(path,coll,at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET at=excluded.at');

// ---------- shared store operations (used by the website API and the MCP endpoint) ----------
class StoreError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
function sGet(dp) { if (!validPath(dp, true)) throw new StoreError('Bad path'); const r = qGet.get(dp); return r ? { exists: true, data: JSON.parse(r.data) } : { exists: false }; }
function sWrite(dp, data, mergeIt) {
  if (!validPath(dp, true)) throw new StoreError('Bad path');
  if (!isObj(data)) throw new StoreError('Body must be an object');
  let body = data;
  if (mergeIt) { const r = qGet.get(dp); if (!r) throw new StoreError('Document does not exist'); body = merge(JSON.parse(r.data), data); }
  const str = JSON.stringify(body); if (str.length > 1024 * 1024) throw new StoreError('Document too large');
  qPut.run(dp, collOf(dp), str, now()); qTombDel.run(dp); broadcast([dp]);
}
function sDelete(dp) { if (!validPath(dp, true)) throw new StoreError('Bad path'); qDel.run(dp); qTomb.run(dp, collOf(dp), now()); broadcast([dp]); }
function sQuery({ coll, where = [], orderBy, dir = 'asc', limit }) {
  if (!validPath(coll, false)) throw new StoreError('Bad path');
  let docs = qColl.all(coll).map(r => ({ id: r.path.split('/').pop(), data: JSON.parse(r.data) }));
  for (const w of where || []) { const f = OPS[w.op]; if (!f) throw new StoreError('Bad operator'); docs = docs.filter(d => d.data[w.field] !== undefined && f(d.data[w.field], w.value)); }
  if (orderBy) docs.sort((x, y) => cmp(x.data[orderBy], y.data[orderBy]) * (dir === 'desc' ? -1 : 1));
  else docs.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (limit) docs = docs.slice(0, Number(limit));
  return { docs };
}
function sImport(docs, replace) {
  if (!Array.isArray(docs) || !docs.length) throw new StoreError('No records');
  if (docs.some(d => !d || !validPath(d.path, true) || !isObj(d.data))) throw new StoreError('Invalid record');
  const t = now();
  db.exec('BEGIN');
  try { if (replace) db.exec('DELETE FROM docs'); for (const d of docs) { qPut.run(d.path, collOf(d.path), JSON.stringify(d.data), t); qTombDel.run(d.path); } db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw new StoreError(e.message); }
  broadcast(['*']); return { imported: docs.length };
}
function sChanges(since) {
  const t = now(); since = String(since || '');
  const changed = db.prepare('SELECT path FROM docs WHERE updated_at>=?').all(since).map(r => r.path);
  const gone = db.prepare('SELECT path FROM deleted WHERE at>=?').all(since).map(r => r.path);
  return { now: t, paths: changed.concat(gone), count: db.prepare('SELECT count(*) n FROM docs').get().n };
}

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

// ---------- MCP endpoint: lets the Claude version of the Hub use this database as its own ----------
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const pathProp = { type: 'string', description: 'Document path, e.g. indicators/R1-01' };
const objProp = { type: 'object', description: 'Document body (JSON object)' };
const TOOLS = [
  { name: 'hub_get', description: 'Read one MEAL Hub document by path.', inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'] }, run: a => sGet(a.path) },
  { name: 'hub_query', description: 'List documents in a MEAL Hub collection, optionally filtered and sorted.', inputSchema: { type: 'object', properties: { coll: { type: 'string' }, where: { type: 'array', items: { type: 'object' } }, orderBy: { type: 'string' }, dir: { type: 'string' }, limit: { type: 'number' } }, required: ['coll'] }, run: a => sQuery(a) },
  { name: 'hub_set', description: 'Create or replace a MEAL Hub document.', inputSchema: { type: 'object', properties: { path: pathProp, data: objProp }, required: ['path', 'data'] }, run: a => (sWrite(a.path, a.data, false), { ok: true }) },
  { name: 'hub_update', description: 'Merge fields into an existing MEAL Hub document.', inputSchema: { type: 'object', properties: { path: pathProp, data: objProp }, required: ['path', 'data'] }, run: a => (sWrite(a.path, a.data, true), { ok: true }) },
  { name: 'hub_delete', description: 'Delete a MEAL Hub document.', inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'] }, run: a => (sDelete(a.path), { ok: true }) },
  { name: 'hub_changes', description: 'Paths of MEAL Hub documents changed or deleted since a timestamp, plus the total document count.', inputSchema: { type: 'object', properties: { since: { type: 'string' } } }, run: a => sChanges(a.since) },
  { name: 'hub_counts', description: 'Number of MEAL Hub documents in each collection.', inputSchema: { type: 'object', properties: {} }, run: () => Object.fromEntries(db.prepare('SELECT coll, count(*) n FROM docs GROUP BY coll').all().map(r => [r.coll, r.n])) },
  { name: 'hub_import', description: 'Bulk-write MEAL Hub documents (used for the first copy of data).', inputSchema: { type: 'object', properties: { docs: { type: 'array', items: { type: 'object' } }, replace: { type: 'boolean' } }, required: ['docs'] }, run: a => sImport(a.docs, a.replace) },
];
async function mcp(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, Object.assign({ Allow: 'POST' }, cors)); return res.end(); }
  const msg = await json(req);
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notification
    const reply = r => out.push(Object.assign({ jsonrpc: '2.0', id: m.id }, r));
    try {
      if (m.method === 'initialize') reply({ result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ohnez-meal-hub', version: '1.0.0' } } });
      else if (m.method === 'ping') reply({ result: {} });
      else if (m.method === 'tools/list') reply({ result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      else if (m.method === 'tools/call') {
        const t = TOOLS.find(x => x.name === (m.params && m.params.name));
        console.log('mcp', m.params && m.params.name, JSON.stringify((m.params && m.params.arguments) || {}).slice(0, 120));
        if (!t) reply({ error: { code: -32602, message: 'Unknown tool' } });
        else {
          try { const r = t.run((m.params && m.params.arguments) || {}); reply({ result: { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r } }); }
          catch (e) { console.log('mcp error', e.message); reply({ result: { isError: true, content: [{ type: 'text', text: e.message }] } }); }
        }
      } else reply({ error: { code: -32601, message: 'Method not found' } });
    } catch (e) { reply({ error: { code: -32603, message: e.message } }); }
  }
  if (!out.length) { res.writeHead(202, cors); return res.end(); }
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
  res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const user = currentUser(req);
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (p === '/healthz') return send(res, 200, 'ok docs=' + db.prepare('SELECT count(*) n FROM docs').get().n + ' users=' + db.prepare('SELECT count(*) n FROM users').get().n);
  if (MCP_TOKEN && p === '/mcp/' + MCP_TOKEN) return mcp(req, res);
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
    if (m === 'GET') return send(res, 200, sGet(url.searchParams.get('path')));
    if (m === 'DELETE') { if (needWrite()) return; sDelete(url.searchParams.get('path')); return send(res, 200, { ok: true }); }
    if (m === 'PUT' || m === 'PATCH') { if (needWrite()) return; const { path: dp, data } = await json(req); sWrite(dp, data, m === 'PATCH'); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/query' && m === 'POST') return send(res, 200, sQuery(await json(req)));

  // import / backup (admin)
  if (p === '/api/import' && m === 'POST') { if (needAdmin()) return; const b = await json(req); return send(res, 200, Object.assign({ ok: true }, sImport(b.docs, b.replace))); }
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
  handle(req, res).catch(e => { if (!(e instanceof StoreError)) console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }); });
}).listen(PORT, () => console.log('OHNEZ MEAL Hub listening on', PORT, 'data in', DATA_DIR));
