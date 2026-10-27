// Email/password accounts with server-side sessions in an httpOnly cookie.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getDb, newId, now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'rw_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('An account with this email already exists. Log in instead.');
  const user = { id: newId(), email, name: String(name || '').trim().slice(0, 80), password_hash: await hashPassword(password), created_at: now() };
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, user.email, user.name, user.password_hash, user.created_at);
  return getUser(user.id);
}

export async function authenticate(email, password) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Hash anyway on unknown emails so response time doesn't reveal which emails exist.
  const ok = row ? await verifyPassword(String(password || ''), row.password_hash) : (await hashPassword('timing'), false);
  if (!ok) throw new Error('Incorrect email or password.');
  return getUser(row.id);
}

export function getUser(id) {
  const row = getDb().prepare('SELECT id, email, name, plan, plan_status, stripe_customer_id, stripe_subscription_id, created_at FROM users WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Max-Age=${SESSION_MS / 1000}; ${cookieOptions()}`);
}

export function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieOptions()}`);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = getDb().prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), now());
    if (row) req.user = getUser(row.user_id);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.', code: 'auth' });
  next();
}

/**
 * CSRF defence for cookie-authenticated APIs: state-changing requests must be
 * JSON (which cross-site forms can't send) and, when the browser sends an
 * Origin header, it must match this host.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'Requests must be sent as JSON.' });
  }
  next();
}
