import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { crawlSite } from './lib/crawler.js';
import { runAudit, auditContext, auditPatched } from './lib/audit/index.js';
import { buildFixPack, brandName } from './lib/fixer.js';
import { aiEnabled, MODEL, expertReview, strategistReply, writeArticle } from './lib/ai.js';
import { ruleReview, ruleStrategist, templateArticle } from './lib/fallback.js';
import { getDb } from './lib/db.js';
import { createUser, authenticate, startSession, endSession, loadUser, requireUser, csrfGuard } from './lib/auth.js';
import { usage, effectivePlan, requirePro, billingEnabled, createCheckout, createPortal, handleWebhook, PLANS } from './lib/billing.js';
import { buildDeployPayload, simulateSnippet, snippetPresent, snippetJs, diffAudits } from './lib/deploy.js';
import { verifyConnection, publishArticle, publishFaqPage } from './lib/wordpress.js';
import * as store from './lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
getDb();

const baseUrl = (req) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!req.path.startsWith('/s/')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Previews of customer pages load their images/styles, so those directives stay open.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:; frame-src 'self'; form-action 'self' https://checkout.stripe.com");
  }
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- Stripe webhook (needs the raw body, so it is registered before express.json)
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!billingEnabled()) return res.status(404).end();
  try {
    res.json(await handleWebhook(req.body, req.headers['stripe-signature']));
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---- Public snippet that applies published fixes on the customer's site
app.get('/s/:key.js', (req, res) => {
  const project = store.getProjectBySnippetKey(req.params.key);
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300');
  res.setHeader('access-control-allow-origin', '*');
  if (!project) return res.send('/* Rankwise: unknown site key */');
  try {
    const referer = req.get('referer');
    if (referer && new URL(referer).hostname.replace(/^www\./, '') === new URL(project.origin).hostname.replace(/^www\./, '')) store.touchSnippet(project.id);
  } catch { /* ignore malformed referers */ }
  res.send(snippetJs(store.getDeployment(project.id)?.payload));
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(here, 'public')));
app.use('/vendor/marked.js', express.static(path.join(here, 'node_modules/marked/lib/marked.umd.js')));
app.use('/api', loadUser, csrfGuard);

// ---- Tiny per-IP rate limiter for expensive endpoints
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.route?.path || req.path}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'Too many requests — please wait a minute and try again.' });
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.at(-1) > windowMs) hits.delete(k);
    next();
  };
}

// ---- Server-sent events over a POST response
function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => res.end(),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Auth
const me = (user) => ({ user: user ? { id: user.id, email: user.email, name: user.name } : null, usage: user ? usage(user) : null, ai: aiEnabled(), model: aiEnabled() ? MODEL : null, billing: billingEnabled(), plans: PLANS });

app.get('/api/me', (req, res) => res.json(me(req.user)));

app.post('/api/auth/signup', rateLimit(10, 60 * 60_000), wrap(async (req, res) => {
  try {
    const user = await createUser(req.body || {});
    startSession(res, user.id);
    res.json(me(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/auth/login', rateLimit(10, 15 * 60_000), wrap(async (req, res) => {
  try {
    const user = await authenticate(req.body?.email, req.body?.password);
    startSession(res, user.id);
    res.json(me(user));
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}));

app.post('/api/auth/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// ---- Billing
app.post('/api/billing/checkout', requireUser, wrap(async (req, res) => {
  if (!billingEnabled()) return res.status(400).json({ error: 'Billing is not configured on this server (demo mode: Pro is already unlocked).' });
  res.json({ url: await createCheckout(req.user, baseUrl(req)) });
}));
app.post('/api/billing/portal', requireUser, wrap(async (req, res) => {
  if (!billingEnabled()) return res.status(400).json({ error: 'Billing is not configured on this server.' });
  res.json({ url: await createPortal(req.user, baseUrl(req)) });
}));

// ---- Projects
app.get('/api/projects', requireUser, (req, res) => res.json(store.listProjects(req.user.id)));

app.get('/api/projects/:id', requireUser, (req, res) => {
  const project = store.getProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const deployment = store.getDeployment(project.id);
  res.json({
    ...project,
    snippetUrl: `${baseUrl(req)}/s/${project.snippet_key}.js`,
    audits: store.listAudits(project.id),
    connection: store.getConnection(project.id),
    deployment: deployment && { auditId: deployment.auditId, publishedAt: deployment.publishedAt, changes: deployment.payload.changes || [] },
    articles: store.listArticles(project.id),
  });
});

app.delete('/api/projects/:id', requireUser, (req, res) => {
  if (!store.deleteProject(req.params.id, req.user.id)) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true });
});

// ---- Audits
function loadAudit(req, res) {
  const record = store.getAudit(req.params.id, req.user.id);
  if (!record) res.status(404).json({ error: 'Audit not found.' });
  return record;
}

/** The view that matters for scoring: rendered (with snippet) when present, else raw HTML. */
const effective = (record) => record.rendered || record.audit;

function publicAudit(record, user) {
  const { crawl, audit } = record;
  const project = store.getProject(record.projectId, user.id);
  const prevRow = store.previousAudit(record.projectId, record.createdAt);
  const prev = prevRow && store.getAudit(prevRow.id, user.id);
  return {
    id: record.id,
    projectId: record.projectId,
    url: crawl.finalUrl,
    crawledAt: crawl.crawledAt,
    pages: crawl.pages.map((p) => ({ url: p.url, status: p.status, title: p.title, words: p.wordCount, error: p.error })),
    infra: { robots: crawl.robots.found, sitemap: crawl.sitemap, llmsTxt: crawl.llmsTxt.found, https: crawl.https },
    snippet: { installed: snippetPresent(crawl.homeHtml, project.snippet_key), lastSeen: project.snippet_last_seen, published: Boolean(store.getDeployment(project.id)) },
    ...audit,
    rendered: record.rendered ? { scores: record.rendered.scores, summary: record.rendered.summary } : null,
    comparison: prev ? {
      previousId: prev.id,
      previousAt: prev.createdAt,
      before: effective(prev).scores,
      after: effective(record).scores,
      ...diffAudits(effective(prev), effective(record)),
    } : null,
    hasReview: Boolean(record.review),
    plan: effectivePlan(user),
  };
}

app.post('/api/audits', requireUser, rateLimit(10, 60_000), async (req, res) => {
  const u = usage(req.user);
  if (u.used >= u.limit) {
    return res.status(402).json({ error: u.plan === 'free' ? `You've used all ${u.limit} free audits this month. Upgrade to Pro for unlimited audits.` : 'Monthly audit limit reached.', code: 'upgrade' });
  }
  const stream = sse(res);
  try {
    const crawl = await crawlSite(req.body?.url, { onProgress: (msg) => stream.send('progress', { message: msg }) });
    stream.send('progress', { message: 'Running SEO, AEO and GEO checks' });
    const audit = runAudit(crawl);
    const project = store.upsertProject(req.user.id, crawl);

    // If the Rankwise snippet is live, also audit the page the way Google renders it.
    let rendered = null;
    const deployment = store.getDeployment(project.id);
    if (deployment && snippetPresent(crawl.homeHtml, project.snippet_key)) {
      stream.send('progress', { message: 'Rankwise snippet detected — auditing the rendered page' });
      rendered = auditPatched(crawl, simulateSnippet(crawl, deployment.payload));
    }
    const id = store.saveAudit({ projectId: project.id, userId: req.user.id, crawl, audit, rendered });
    stream.send('result', publicAudit(store.getAudit(id, req.user.id), req.user));
  } catch (err) {
    console.error('Audit failed:', err.message);
    stream.send('error', { error: err.message });
  }
  stream.end();
});

app.get('/api/audits/:id', requireUser, (req, res) => {
  const record = loadAudit(req, res);
  if (record) res.json(publicAudit(record, req.user));
});

const inflightReviews = new Map();
async function getReview(record, user) {
  const pro = effectivePlan(user) === 'pro';
  if (record.review && (record.review.source === 'ai' || !pro || !aiEnabled())) return record.review;
  let review;
  if (pro && aiEnabled()) {
    try {
      review = await expertReview(auditContext(record));
    } catch (err) {
      console.error('Expert review failed, using rules engine:', err.message);
      return { ...ruleReview(record), warning: `AI review unavailable (${err.message}); showing the rules-based review.` };
    }
  } else {
    review = ruleReview(record);
  }
  store.setReview(record.id, review);
  record.review = review;
  return review;
}

app.post('/api/audits/:id/review', requireUser, rateLimit(6, 60_000), wrap(async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  if (!inflightReviews.has(record.id)) inflightReviews.set(record.id, getReview(record, req.user).finally(() => inflightReviews.delete(record.id)));
  const review = await inflightReviews.get(record.id);
  res.json({ ...review, locked: effectivePlan(req.user) !== 'pro' && aiEnabled() });
}));

async function getFixPack(record, user, { refresh = false } = {}) {
  if (record.fixPack && !refresh) return record.fixPack;
  const review = record.review || (await getReview(record, user));
  const copy = review?.optimizedCopy ? { ...review.optimizedCopy, source: review.source } : undefined;
  const pack = buildFixPack(record.crawl, record.audit, copy);
  const after = auditPatched(record.crawl, pack.files['index.optimized.html'], {
    robotsBody: pack.files['robots.txt'],
    sitemapUrls: (pack.files['sitemap.xml'].match(/<loc>/g) || []).length,
    llmsTxt: pack.files['llms.txt'],
  });
  record.fixPack = { ...pack, before: record.audit.scores, after: after.scores, remaining: after.checks.filter((c) => c.status !== 'pass') };
  store.setFixPack(record.id, record.fixPack);
  return record.fixPack;
}

app.post('/api/audits/:id/fixes', requireUser, requirePro('the fix pack'), wrap(async (req, res) => {
  const record = loadAudit(req, res);
  if (record) res.json(await getFixPack(record, req.user, { refresh: Boolean(req.body?.refresh) }));
}));

app.get('/api/audits/:id/fixes.zip', requireUser, requirePro('the fix pack'), wrap(async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  const pack = await getFixPack(record, req.user);
  const zip = new JSZip();
  for (const [name, content] of Object.entries(pack.files)) zip.file(name, content);
  for (const a of store.listArticles(record.projectId)) zip.file(`articles/${a.keyword.replace(/[^a-z0-9]+/gi, '-')}.md`, a.markdown);
  zip.file('IMPLEMENTATION.md', implementationGuide(record, pack));
  const host = new URL(record.crawl.finalUrl).hostname;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="rankwise-fixes-${host}.zip"`);
  res.send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}));

function implementationGuide(record, pack) {
  return `# Rankwise fix pack for ${record.crawl.finalUrl}

Score before: ${pack.before.overall}/100 (SEO ${pack.before.seo} · AEO ${pack.before.aeo} · GEO ${pack.before.geo})
Projected after deploying this pack: ${pack.after.overall}/100 (SEO ${pack.after.seo} · AEO ${pack.after.aeo} · GEO ${pack.after.geo})

## Fastest path: the Rankwise snippet
In Rankwise, open **Go live**, click **Publish fixes**, and add the one-line script tag to your site's <head> once.
Title, meta description, canonical, social tags, structured data, alt text and the FAQ section then apply automatically,
and every future "Publish" updates them without touching your site again.

## Files that must live at your domain root
- **robots.txt**: lets search and AI answer engines crawl you and points to your sitemap
- **sitemap.xml**: submit it in Google Search Console and Bing Webmaster Tools
- **llms.txt**: a curated summary of your business for LLMs (GEO)

Per platform:
- WordPress: manage robots/sitemap with Yoast or Rank Math; upload llms.txt via SFTP or a file-manager plugin.
- Shopify: edit robots.txt.liquid; the sitemap is automatic; serve llms.txt with a URL redirect to a file in Content → Files.
- Webflow/Wix/Squarespace: use the SEO settings for robots/sitemap; add the snippet under custom code.

## What was changed automatically
${pack.changes.map((c) => `- ${c}`).join('\n')}

## Still needs a human (${pack.remaining.length})
${pack.remaining.map((c) => `- **${c.title}** (${c.pillar.toUpperCase()}): ${c.recommendation}`).join('\n') || '- Nothing — great work!'}

## Verify
After deploying, click **Verify live site** in Rankwise to re-audit and see exactly which checks were fixed.
`;
}

// ---- Go live: snippet deployment
app.post('/api/audits/:id/deploy', requireUser, requirePro('live deployment'), wrap(async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  const pack = await getFixPack(record, req.user);
  const payload = { ...buildDeployPayload(record.crawl, pack), changes: pack.changes.filter((c) => !/lazy-loaded/i.test(c)) };
  store.saveDeployment(record.projectId, record.id, payload);
  res.json({ ok: true, publishedAt: Date.now(), changes: payload.changes });
}));

app.delete('/api/projects/:id/deploy', requireUser, (req, res) => {
  const project = store.getProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  store.deleteDeployment(project.id);
  res.json({ ok: true });
});

// ---- Go live: WordPress
app.post('/api/projects/:id/wordpress', requireUser, requirePro('WordPress publishing'), rateLimit(10, 60_000), wrap(async (req, res) => {
  const project = store.getProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    const verified = await verifyConnection({ siteUrl: req.body?.siteUrl || project.origin, username: req.body?.username, password: req.body?.password });
    store.saveConnection(project.id, verified);
    res.json(store.getConnection(project.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.delete('/api/projects/:id/wordpress', requireUser, (req, res) => {
  const project = store.getProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  store.deleteConnection(project.id);
  res.json({ ok: true });
});

function wpFor(projectId, res) {
  const c = store.getConnection(projectId, { withSecret: true });
  if (!c) res.status(400).json({ error: 'Connect WordPress first.' });
  return c;
}

app.post('/api/audits/:id/wordpress/faq', requireUser, requirePro('WordPress publishing'), wrap(async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  const wp = wpFor(record.projectId, res);
  if (!wp) return;
  try {
    const pack = await getFixPack(record, req.user);
    const page = await publishFaqPage(wp.conn, wp.meta, { faqs: pack.copy.faqs, brand: brandName(record.crawl) }, { status: req.body?.status === 'draft' ? 'draft' : 'publish' });
    store.saveConnection(record.projectId, { conn: wp.conn, meta: { ...wp.meta, faqPage: page } });
    res.json(page);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/articles/:id/wordpress', requireUser, requirePro('WordPress publishing'), wrap(async (req, res) => {
  const article = store.getArticle(req.params.id, req.user.id);
  if (!article) return res.status(404).json({ error: 'Article not found.' });
  const wp = wpFor(article.project_id, res);
  if (!wp) return;
  try {
    const post = await publishArticle(wp.conn, wp.meta, article.markdown, { status: req.body?.status === 'publish' ? 'publish' : 'draft', postId: article.wp_post_id });
    store.setArticleWp(article.id, post);
    res.json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ---- Strategist chat
app.get('/api/audits/:id/chat', requireUser, (req, res) => {
  const record = loadAudit(req, res);
  if (record) res.json(store.chatHistory(record.id));
});

app.post('/api/audits/:id/chat', requireUser, requirePro('the AI strategist'), rateLimit(20, 60_000), async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  const question = String(req.body?.message || '').trim().slice(0, 8000);
  if (!question) return res.status(400).json({ error: 'Send a question.' });
  store.addChat(record.id, 'user', question);
  const history = store.chatHistory(record.id).slice(-20);

  const stream = sse(res);
  let reply = '';
  try {
    if (aiEnabled()) {
      await strategistReply(auditContext(record), history, (text) => { reply += text; stream.send('text', { text }); });
    } else {
      reply = ruleStrategist(record, question);
      stream.send('text', { text: reply });
    }
  } catch (err) {
    stream.send('error', { error: err.message });
  }
  if (reply) store.addChat(record.id, 'assistant', reply);
  stream.send('done', {});
  stream.end();
});

// ---- Articles
app.post('/api/audits/:id/articles', requireUser, requirePro('AI articles'), rateLimit(5, 60_000), async (req, res) => {
  const record = loadAudit(req, res);
  if (!record) return;
  const keyword = String(req.body?.keyword || '').trim().toLowerCase().slice(0, 120);
  if (!keyword) return res.status(400).json({ error: 'Choose a keyword.' });
  const secondary = (Array.isArray(req.body?.secondary) ? req.body.secondary : []).map((s) => String(s).slice(0, 80)).slice(0, 8);

  const stream = sse(res);
  let full = '';
  try {
    if (aiEnabled()) {
      await writeArticle(
        { context: auditContext(record), keyword, secondary, angle: String(req.body?.angle || '').slice(0, 300), tone: String(req.body?.tone || '').slice(0, 80) },
        (text) => { full += text; stream.send('text', { text }); },
      );
    } else {
      full = templateArticle(record, keyword, secondary);
      stream.send('text', { text: full });
    }
    const id = store.saveArticle({ projectId: record.projectId, auditId: record.id, keyword, markdown: full });
    stream.send('saved', { id });
  } catch (err) {
    stream.send('error', { error: err.message });
  }
  stream.send('done', {});
  stream.end();
});

// ---- Errors
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Something went wrong.' });
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && !process.env.APP_SECRET) {
    console.error('APP_SECRET must be set in production (it encrypts stored WordPress credentials).');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Rankwise running on http://localhost:${port} — AI ${aiEnabled() ? `enabled (${MODEL})` : 'disabled (set ANTHROPIC_API_KEY)'} — billing ${billingEnabled() ? 'enabled' : 'demo mode (all features unlocked)'}`);
  });
}
