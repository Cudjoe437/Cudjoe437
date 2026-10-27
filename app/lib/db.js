// SQLite persistence (Node's built-in driver — no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');

let db;

export function getDb() {
  if (db) return db;
  const file = process.env.DATABASE_FILE || path.join(DATA_DIR, 'rankwise.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan_status TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      snippet_key TEXT NOT NULL UNIQUE,
      snippet_last_seen INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, origin)
    );
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      scores TEXT NOT NULL,
      crawl TEXT NOT NULL,
      audit TEXT NOT NULL,
      rendered TEXT,
      review TEXT,
      fix_pack TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audits_project ON audits(project_id, created_at);
    CREATE INDEX IF NOT EXISTS audits_user ON audits(user_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      audit_id TEXT,
      keyword TEXT NOT NULL,
      markdown TEXT NOT NULL,
      wp_post_id INTEGER,
      wp_url TEXT,
      wp_status TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connections (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      site_url TEXT NOT NULL,
      username TEXT NOT NULL,
      secret TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployments (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      audit_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      faq_page_url TEXT,
      published_at INTEGER NOT NULL
    );
  `);
  return db;
}

export const newId = () => crypto.randomUUID();
export const now = () => Date.now();
export const json = (v) => (v == null ? null : JSON.stringify(v));
export const parse = (v) => (v == null ? null : JSON.parse(v));

// ---- Secret encryption for third-party credentials (AES-256-GCM)
let secretKey;
function key() {
  if (secretKey) return secretKey;
  let secret = process.env.APP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_SECRET must be set in production.');
    const file = path.join(DATA_DIR, '.app-secret');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  secretKey = crypto.createHash('sha256').update(secret).digest();
  return secretKey;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
