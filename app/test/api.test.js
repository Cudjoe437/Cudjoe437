// End-to-end API test: account → audit → review → fixes → publish via snippet
// → verify re-audit, WordPress publishing, Stripe billing, and CSRF guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

process.env.DATABASE_FILE = ':memory:';
process.env.ALLOW_PRIVATE_HOSTS = '1';
process.env.APP_SECRET = 'test-secret';
process.env.AI_DISABLED = '1';
delete process.env.STRIPE_SECRET_KEY;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

// Customer site; `snippetTag` simulates the customer installing the Rankwise snippet.
let snippetTag = '';
const site = http.createServer(async (req, res) => {
  let file = path.join(fixtureDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (file.endsWith('/')) file += 'index.html';
  try {
    let body = await fs.readFile(file, 'utf8');
    if (file.endsWith('fixture/index.html') && snippetTag) body = body.replace('</head>', `${snippetTag}</head>`);
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
  }
});

// Minimal WordPress REST API mock.
const wpPosts = [];
const wpPages = [];
const wp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers.authorization !== `Basic ${Buffer.from('editor:abcdefghijklmnop').toString('base64')}`) return send(401, { code: 'rest_not_logged_in', message: 'Invalid credentials' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/wp-json/wp/v2/users/me') return send(200, { name: 'Ed', roles: ['editor'], capabilities: { publish_posts: true, edit_posts: true, publish_pages: true, unfiltered_html: true } });
    if (url.pathname === '/wp-json/wp/v2/posts' && req.method === 'POST') {
      const data = JSON.parse(body);
      if (data.meta) return send(400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): meta' });
      wpPosts.push(data);
      return send(201, { id: wpPosts.length, link: `http://wp.test/?p=${wpPosts.length}`, status: data.status });
    }
    if (url.pathname === '/wp-json/wp/v2/pages' && req.method === 'GET') return send(200, []);
    if (url.pathname === '/wp-json/wp/v2/pages' && req.method === 'POST') {
      wpPages.push(JSON.parse(body));
      return send(201, { id: 10, link: 'http://wp.test/faq/', status: 'publish' });
    }
    send(404, { code: 'rest_no_route', message: 'No route' });
  });
});

let appUrl, siteUrl, wpUrl, appServer;
before(async () => {
  siteUrl = await listen(site);
  wpUrl = await listen(wp);
  const { default: app } = await import('../server.js');
  appServer = http.createServer(app);
  appUrl = await listen(appServer);
});
after(() => [site, wp, appServer].forEach((s) => s.close()));

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(appUrl + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (type.includes('event-stream')) {
      const events = {};
      for (const frame of (await res.text()).split('\n\n')) {
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev) (events[ev] ||= []).push(JSON.parse(data));
      }
      return { status: res.status, events };
    }
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return call;
}

test('full customer journey', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/audits', { url: siteUrl })).status, 401, 'audits need an account');

  const signup = await api('POST', '/api/auth/signup', { email: 'Owner@Example.com', password: 'hunter2hunter2', name: 'Owner' });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.user.email, 'owner@example.com');
  assert.equal(signup.body.usage.plan, 'pro', 'demo mode unlocks Pro');

  // 1. Audit
  const first = await api('POST', '/api/audits', { url: `${siteUrl}/` });
  const audit = first.events.result?.[0];
  assert.ok(audit, JSON.stringify(first.events.error));
  assert.ok(first.events.progress.length >= 3);
  assert.equal(audit.comparison, null);
  assert.equal(audit.snippet.installed, false);

  // 2. Review + fixes
  const review = await api('POST', `/api/audits/${audit.id}/review`, {});
  assert.equal(review.status, 200);
  assert.ok(review.body.findings.length);
  const fixes = await api('POST', `/api/audits/${audit.id}/fixes`, {});
  assert.ok(fixes.body.after.overall > fixes.body.before.overall);
  const zip = await api('GET', `/api/audits/${audit.id}/fixes.zip`);
  assert.equal(zip.status, 200);

  // 3. Strategist (offline rules mode) persists history
  const chat = await api('POST', `/api/audits/${audit.id}/chat`, { message: 'what is my score?' });
  assert.match(chat.events.text[0].text, /overall score/);
  assert.equal((await api('GET', `/api/audits/${audit.id}/chat`)).body.length, 2);

  // 4. Publish fixes and serve the snippet
  const deploy = await api('POST', `/api/audits/${audit.id}/deploy`, {});
  assert.equal(deploy.status, 200);
  const project = (await api('GET', `/api/projects/${audit.projectId}`)).body;
  assert.ok(project.deployment);
  const js = await api('GET', `/s/${project.snippet_key}.js`, undefined, { referer: `${siteUrl}/` });
  assert.match(js.body, /"title":"Custom Wedding Cakes/);
  assert.doesNotMatch(js.body, /<\/script>/i);
  assert.ok((await api('GET', `/api/projects/${audit.projectId}`)).body.snippet_last_seen, 'snippet records it was seen on the site');

  // 5. Customer installs the snippet, then verifies
  snippetTag = `<script src="${project.snippetUrl}" async></script>`;
  const second = (await api('POST', '/api/audits', { url: `${siteUrl}/` })).events.result[0];
  assert.equal(second.snippet.installed, true);
  assert.ok(second.rendered, 'audits the page as rendered with the snippet');
  assert.ok(second.comparison.after.overall > second.comparison.before.overall, JSON.stringify(second.comparison && [second.comparison.before, second.comparison.after]));
  assert.ok(second.comparison.fixed.some((c) => c.id === 'seo:indexable'));
  assert.ok(second.comparison.fixed.some((c) => c.id === 'aeo:faq-schema'));
  const projects = (await api('GET', '/api/projects')).body;
  assert.equal(projects[0].history.length, 2);

  // 6. Articles + WordPress
  const article = await api('POST', `/api/audits/${second.id}/articles`, { keyword: 'custom wedding cakes' });
  const articleId = article.events.saved[0].id;
  assert.equal((await api('POST', `/api/projects/${audit.projectId}/wordpress`, { siteUrl: wpUrl, username: 'editor', password: 'wrong' })).status, 400);
  const conn = await api('POST', `/api/projects/${audit.projectId}/wordpress`, { siteUrl: wpUrl, username: 'editor', password: 'abcd efgh ijkl mnop' });
  assert.equal(conn.status, 200, JSON.stringify(conn.body));
  assert.equal(conn.body.meta.user, 'Ed');
  assert.equal(conn.body.secret, undefined, 'never returns the stored secret');
  const post = await api('POST', `/api/articles/${articleId}/wordpress`, { status: 'draft' });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal(wpPosts[0].status, 'draft');
  assert.match(wpPosts[0].content, /<h2/);
  assert.equal(wpPosts[0].slug, 'custom-wedding-cakes');
  const faq = await api('POST', `/api/audits/${second.id}/wordpress/faq`, {});
  assert.equal(faq.status, 200, JSON.stringify(faq.body));
  assert.match(wpPages[0].content, /FAQPage/);

  // 7. Another user can't see this data
  const other = client();
  await other('POST', '/api/auth/signup', { email: 'other@example.com', password: 'password123' });
  assert.equal((await other('GET', `/api/audits/${audit.id}`)).status, 404);
  assert.equal((await other('GET', `/api/projects/${audit.projectId}`)).status, 404);

  // 8. Logout / login
  await api('POST', '/api/auth/logout', {});
  assert.equal((await api('GET', '/api/me')).body.user, null);
  assert.equal((await api('POST', '/api/auth/login', { email: 'owner@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { email: 'owner@example.com', password: 'hunter2hunter2' })).status, 200);
});

test('CSRF guards', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/auth/signup', 'email=a@b.co&password=12345678', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'x@y.co', password: '12345678' }, { origin: 'https://evil.example' })).status, 403);
});

test('Stripe billing gates Pro features and applies webhooks', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_ID = 'price_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  try {
    const api = client();
    const me = (await api('POST', '/api/auth/signup', { email: 'payer@example.com', password: 'password123' })).body;
    assert.equal(me.usage.plan, 'free');
    const audit = (await api('POST', '/api/audits', { url: `${siteUrl}/` })).events.result[0];
    const review = await api('POST', `/api/audits/${audit.id}/review`, {});
    assert.equal(review.body.source, 'rules');
    assert.equal((await api('POST', `/api/audits/${audit.id}/fixes`, {})).status, 402);
    assert.equal((await api('POST', `/api/audits/${audit.id}/deploy`, {})).status, 402);

    const { getDb } = await import('../lib/db.js');
    getDb().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_123', me.user.id);
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_123', status: 'active' } } });
    const stripe = new Stripe('sk_test_dummy');
    const bad = await api('POST', '/api/billing/webhook', payload, { 'stripe-signature': 't=1,v1=bad' });
    assert.equal(bad.status, 400);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    const ok = await api('POST', '/api/billing/webhook', payload, { 'stripe-signature': sig });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await api('GET', '/api/me')).body.usage.plan, 'pro');
    assert.equal((await api('POST', `/api/audits/${audit.id}/fixes`, {})).status, 200);

    // Free-plan monthly audit limit
    getDb().prepare("UPDATE users SET plan = 'free', plan_status = 'canceled' WHERE id = ?").run(me.user.id);
    await api('POST', '/api/audits', { url: `${siteUrl}/` });
    await api('POST', '/api/audits', { url: `${siteUrl}/` });
    const blocked = await api('POST', '/api/audits', { url: `${siteUrl}/` });
    assert.equal(blocked.status, 402);
    assert.match(blocked.body.error, /free audits/);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
  }
});
