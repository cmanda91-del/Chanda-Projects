import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Session secret: from env, otherwise generated once and persisted on the data volume.
function loadSecret() {
  if (config.sessionSecret && config.sessionSecret.length >= 32) return config.sessionSecret;
  const file = path.join(config.dataDir, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const SESSION_DAYS = 30;

// Password hashing with scrypt (built in, memory-hard).
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

// Signed session tokens: base64url(payload).base64url(hmac)
const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); }

export function createToken(userId) {
  const payload = b64(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}
export function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export function sessionCookie(token) {
  const parts = [`zp_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}
export const clearCookie = () => `zp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.isProd ? '; Secure' : ''}`;

// Zambian mobile numbers -> 0XXXXXXXXX (10 digits). Returns null if invalid.
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('260')) d = '0' + d.slice(3);
  if (d.length === 9) d = '0' + d;
  return /^0[79][5-7]\d{7}$/.test(d) ? d : null;
}
// Operator from prefix: 097/077 Airtel, 096/076 MTN, 095/075 Zamtel
export function detectOperator(phone) {
  const p = phone?.slice(0, 3);
  if (p === '097' || p === '077') return 'airtel';
  if (p === '096' || p === '076') return 'mtn';
  if (p === '095' || p === '075') return 'zamtel';
  return null;
}
