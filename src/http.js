// Minimal HTTP toolkit: router, JSON helpers, cookies, rate limiting, static files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readJson(req, limit = 32 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON');
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// Fixed-window in-memory rate limiter.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++b.count > max) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); } post(p, h) { this.add('POST', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

// Static files are small: cache them in memory, pre-gzipped, keyed by mtime.
const cache = new Map();
function load(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const ext = path.extname(file);
  const compressible = /^(text\/|application\/(json|manifest)|image\/svg)/.test(MIME[ext] || '');
  const entry = { mtime: st.mtimeMs, raw, gz: compressible ? zlib.gzipSync(raw) : null, type: MIME[ext] || 'application/octet-stream', isHtml: ext === '.html' };
  cache.set(file, entry);
  return entry;
}

export function serveStatic(req, res, root, pathname) {
  let rel;
  try { rel = path.normalize(decodeURIComponent(pathname)); } catch { return false; }
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return false;
  let isFile = false;
  try { const st = fs.statSync(file); if (st.isDirectory()) file = path.join(file, 'index.html'); isFile = fs.existsSync(file); } catch {}
  if (!isFile) {
    if (path.extname(rel)) return false;          // missing asset -> 404
    file = path.join(root, 'index.html');          // SPA route -> app shell
  }
  const e = load(file);
  const useGz = e.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = useGz ? e.gz : e.raw;
  const headers = { 'content-type': e.type, 'cache-control': e.isHtml ? 'no-cache' : 'public, max-age=3600', 'content-length': body.length, vary: 'accept-encoding' };
  if (useGz) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
