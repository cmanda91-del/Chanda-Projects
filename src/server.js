import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, aiProvider } from './config.js';
import { q } from './db.js';
import { readToken } from './auth.js';
import { HttpError, json, parseCookies, serveStatic } from './http.js';
import { router } from './routes.js';
import { paymentsEnabled } from './lenco.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (config.isProd) res.setHeader('strict-transport-security', 'max-age=31536000');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const ctx = { req, res, url, params: {}, user: null };
    const tok = readToken(parseCookies(req).zp_session);
    if (tok) ctx.user = q.get('SELECT * FROM users WHERE id=?', tok.uid) || null;
    const m = router.match(req.method, url.pathname);
    if (!m) return json(res, 404, { error: 'Not found' });
    ctx.params = m.params;
    try { await m.handler(ctx); }
    catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error('[error]', req.method, url.pathname, e);
      json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (!serveStatic(req, res, PUBLIC, url.pathname)) { res.writeHead(404); res.end('Not found'); }
});

server.headersTimeout = 65000;
server.requestTimeout = 90000;
server.listen(config.port, () => {
  console.log(`[${config.appName}] listening on :${config.port} | AI: ${aiProvider()} | payments: ${paymentsEnabled() ? 'lenco' : 'off'} | data: ${config.dataDir}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
