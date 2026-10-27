// Data access for projects, audits, chats, articles, connections and deployments.
import crypto from 'node:crypto';
import { getDb, newId, now, json, parse, encrypt, decrypt } from './db.js';
import { brandName } from './brand.js';

// ---- Projects (one per site origin per user)
export function upsertProject(userId, crawl) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM projects WHERE user_id = ? AND origin = ?').get(userId, crawl.origin);
  if (existing) {
    db.prepare('UPDATE projects SET url = ?, name = ? WHERE id = ?').run(crawl.finalUrl, brandName(crawl), existing.id);
    return { ...existing, url: crawl.finalUrl };
  }
  const project = { id: newId(), user_id: userId, origin: crawl.origin, url: crawl.finalUrl, name: brandName(crawl), snippet_key: crypto.randomBytes(12).toString('base64url'), created_at: now() };
  db.prepare('INSERT INTO projects (id, user_id, origin, url, name, snippet_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...Object.values(project));
  return project;
}

export const getProject = (id, userId) => {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? { ...row } : null;
};

export const getProjectBySnippetKey = (key) => {
  const row = getDb().prepare('SELECT * FROM projects WHERE snippet_key = ?').get(key);
  return row ? { ...row } : null;
};

export const touchSnippet = (projectId) => getDb().prepare('UPDATE projects SET snippet_last_seen = ? WHERE id = ?').run(now(), projectId);

export function listProjects(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(userId).map((p) => ({
    ...p,
    history: db.prepare('SELECT id, scores, created_at FROM audits WHERE project_id = ? ORDER BY created_at ASC').all(p.id).map((a) => ({ id: a.id, scores: parse(a.scores), created_at: a.created_at })),
  }));
}

export const deleteProject = (id, userId) => getDb().prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;

// ---- Audits
export function saveAudit({ projectId, userId, crawl, audit, rendered }) {
  const id = newId();
  getDb()
    .prepare('INSERT INTO audits (id, project_id, user_id, url, scores, crawl, audit, rendered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, userId, crawl.finalUrl, json(rendered?.scores || audit.scores), json(crawl), json(audit), json(rendered), now());
  return id;
}

export function getAudit(id, userId) {
  const row = getDb().prepare('SELECT * FROM audits WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    crawl: parse(row.crawl),
    audit: parse(row.audit),
    rendered: parse(row.rendered),
    review: parse(row.review),
    fixPack: parse(row.fix_pack),
  };
}

export const previousAudit = (projectId, beforeTs) =>
  getDb().prepare('SELECT id, user_id FROM audits WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1').get(projectId, beforeTs);

export const setReview = (id, review) => getDb().prepare('UPDATE audits SET review = ? WHERE id = ?').run(json(review), id);
export const setFixPack = (id, pack) => getDb().prepare('UPDATE audits SET fix_pack = ? WHERE id = ?').run(json(pack), id);
export const listAudits = (projectId) =>
  getDb().prepare('SELECT id, url, scores, created_at FROM audits WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map((a) => ({ ...a, scores: parse(a.scores) }));

// ---- Chat
export const chatHistory = (auditId) => getDb().prepare('SELECT role, content FROM chat_messages WHERE audit_id = ? ORDER BY id').all(auditId).map((m) => ({ ...m }));
export const addChat = (auditId, role, content) => getDb().prepare('INSERT INTO chat_messages (audit_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(auditId, role, content, now());

// ---- Articles
export function saveArticle({ projectId, auditId, keyword, markdown }) {
  const id = newId();
  getDb().prepare('INSERT INTO articles (id, project_id, audit_id, keyword, markdown, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, auditId, keyword, markdown, now());
  return id;
}
export const listArticles = (projectId) =>
  getDb().prepare('SELECT id, keyword, markdown, wp_post_id, wp_url, wp_status, created_at FROM articles WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map((a) => ({ ...a }));
export function getArticle(id, userId) {
  const row = getDb().prepare('SELECT a.* FROM articles a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND p.user_id = ?').get(id, userId);
  return row ? { ...row } : null;
}
export const setArticleWp = (id, { id: postId, url, status }) =>
  getDb().prepare('UPDATE articles SET wp_post_id = ?, wp_url = ?, wp_status = ? WHERE id = ?').run(postId, url, status, id);

// ---- WordPress connection (Application Password stored encrypted)
export function saveConnection(projectId, { conn, meta }) {
  getDb()
    .prepare('INSERT OR REPLACE INTO connections (project_id, type, site_url, username, secret, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'wordpress', conn.siteUrl, conn.username, encrypt(conn.password), json(meta), now());
}
export function getConnection(projectId, { withSecret = false } = {}) {
  const row = getDb().prepare('SELECT * FROM connections WHERE project_id = ?').get(projectId);
  if (!row) return null;
  const base = { type: row.type, siteUrl: row.site_url, username: row.username, meta: parse(row.meta), createdAt: row.created_at };
  return withSecret ? { ...base, conn: { siteUrl: row.site_url, username: row.username, password: decrypt(row.secret) } } : base;
}
export const deleteConnection = (projectId) => getDb().prepare('DELETE FROM connections WHERE project_id = ?').run(projectId);

// ---- Snippet deployments
export function saveDeployment(projectId, auditId, payload) {
  getDb()
    .prepare('INSERT INTO deployments (project_id, audit_id, payload, published_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET audit_id = excluded.audit_id, payload = excluded.payload, published_at = excluded.published_at')
    .run(projectId, auditId, json(payload), now());
}
export function getDeployment(projectId) {
  const row = getDb().prepare('SELECT * FROM deployments WHERE project_id = ?').get(projectId);
  return row ? { auditId: row.audit_id, payload: parse(row.payload), faqPageUrl: row.faq_page_url, publishedAt: row.published_at } : null;
}
export const setFaqPageUrl = (projectId, url) => getDb().prepare('UPDATE deployments SET faq_page_url = ? WHERE project_id = ?').run(url, projectId);
export const deleteDeployment = (projectId) => getDb().prepare('DELETE FROM deployments WHERE project_id = ?').run(projectId);
