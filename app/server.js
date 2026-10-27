import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { crawlSite, parsePage, parseRobots } from './lib/crawler.js';
import { runAudit, auditContext } from './lib/audit/index.js';
import { buildFixPack } from './lib/fixer.js';
import { aiEnabled, MODEL, expertReview, strategistReply, writeArticle } from './lib/ai.js';
import { ruleReview, ruleStrategist, templateArticle } from './lib/fallback.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(here, 'public')));
app.use('/vendor/marked.js', express.static(path.join(here, 'node_modules/marked/lib/marked.umd.js')));

// ---- In-memory audit store (bounded, 2h TTL)
const audits = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;
function save(record) {
  const id = crypto.randomUUID();
  audits.set(id, { ...record, id, createdAt: Date.now() });
  for (const [key, value] of audits) {
    if (audits.size <= 200 && Date.now() - value.createdAt < TTL_MS) break;
    audits.delete(key);
  }
  return id;
}
function load(req, res) {
  const record = audits.get(req.params.id);
  if (!record || Date.now() - record.createdAt > TTL_MS) {
    res.status(404).json({ error: 'Audit not found or expired. Please run the audit again.' });
    return null;
  }
  return record;
}

// ---- Tiny per-IP rate limiter for expensive endpoints
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path.split('/').pop()}`;
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

const publicAudit = (record) => ({
  id: record.id,
  url: record.crawl.finalUrl,
  crawledAt: record.crawl.crawledAt,
  pages: record.crawl.pages.map((p) => ({ url: p.url, status: p.status, title: p.title, words: p.wordCount, error: p.error })),
  infra: { robots: record.crawl.robots.found, sitemap: record.crawl.sitemap, llmsTxt: record.crawl.llmsTxt.found, https: record.crawl.https },
  ...record.audit,
});

app.get('/api/status', (_req, res) => res.json({ ai: aiEnabled(), model: aiEnabled() ? MODEL : null }));

app.post('/api/audit', rateLimit(10, 60_000), async (req, res) => {
  const stream = sse(res);
  try {
    const crawl = await crawlSite(req.body?.url, { onProgress: (msg) => stream.send('progress', { message: msg }) });
    stream.send('progress', { message: 'Running SEO, AEO and GEO checks' });
    const audit = runAudit(crawl);
    const id = save({ crawl, audit });
    stream.send('result', publicAudit(audits.get(id)));
  } catch (err) {
    stream.send('error', { error: err.message });
  }
  stream.end();
});

app.get('/api/audit/:id', (req, res) => {
  const record = load(req, res);
  if (record) res.json(publicAudit(record));
});

async function getReview(record) {
  if (record.review) return record.review;
  if (aiEnabled()) {
    try {
      record.review = await expertReview(auditContext(record));
      return record.review;
    } catch (err) {
      console.error('Expert review failed, using rules engine:', err.message);
      record.review = { ...ruleReview(record), warning: `AI review unavailable (${err.message}); showing the rules-based review.` };
      return record.review;
    }
  }
  record.review = ruleReview(record);
  return record.review;
}

app.post('/api/audit/:id/review', rateLimit(6, 60_000), async (req, res) => {
  const record = load(req, res);
  if (!record) return;
  record.reviewPromise ??= getReview(record).finally(() => (record.reviewPromise = null));
  res.json(await record.reviewPromise);
});

/** Re-audit the site as if the fix pack were deployed, to show the projected uplift. */
function projectScores(record, pack) {
  const { crawl } = record;
  const fixedHome = {
    ...parsePage(pack.files['index.optimized.html'], crawl.finalUrl),
    status: crawl.home.status,
    timeMs: crawl.home.timeMs,
    bytes: Buffer.byteLength(pack.files['index.optimized.html']),
    headers: crawl.home.headers,
    redirects: crawl.home.redirects,
  };
  const robotsBody = pack.files['robots.txt'];
  const fixedCrawl = {
    ...crawl,
    home: fixedHome,
    pages: [fixedHome, ...crawl.pages.slice(1)],
    robots: { found: true, status: 200, body: robotsBody, parsed: parseRobots(robotsBody) },
    sitemap: { ...crawl.sitemap, found: true, urlCount: (pack.files['sitemap.xml'].match(/<loc>/g) || []).length },
    llmsTxt: { found: true, body: pack.files['llms.txt'] },
  };
  return runAudit(fixedCrawl);
}

async function getFixPack(record) {
  if (record.fixPack) return record.fixPack;
  const review = record.review || (aiEnabled() ? null : await getReview(record));
  const copy = review?.optimizedCopy ? { ...review.optimizedCopy, source: review.source } : undefined;
  const pack = buildFixPack(record.crawl, record.audit, copy);
  const after = projectScores(record, pack);
  record.fixPack = { ...pack, before: record.audit.scores, after: after.scores, remaining: after.checks.filter((c) => c.status !== 'pass') };
  return record.fixPack;
}

app.post('/api/audit/:id/fixes', async (req, res) => {
  const record = load(req, res);
  if (!record) return;
  try {
    if (req.body?.refresh) record.fixPack = null;
    res.json(await getFixPack(record));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit/:id/fixes.zip', async (req, res) => {
  const record = load(req, res);
  if (!record) return;
  const pack = await getFixPack(record);
  const zip = new JSZip();
  for (const [name, content] of Object.entries(pack.files)) zip.file(name, content);
  for (const [name, content] of Object.entries(record.articles || {})) zip.file(`articles/${name}.md`, content);
  zip.file('IMPLEMENTATION.md', implementationGuide(record, pack));
  const host = new URL(record.crawl.finalUrl).hostname;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="rankwise-fixes-${host}.zip"`);
  res.send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
});

function implementationGuide(record, pack) {
  const manual = pack.remaining;
  return `# Rankwise fix pack for ${record.crawl.finalUrl}

Score before: ${pack.before.overall}/100 (SEO ${pack.before.seo} · AEO ${pack.before.aeo} · GEO ${pack.before.geo})
Projected after deploying this pack: ${pack.after.overall}/100 (SEO ${pack.after.seo} · AEO ${pack.after.aeo} · GEO ${pack.after.geo})

## What was changed automatically
${pack.changes.map((c) => `- ${c}`).join('\n')}

## How to deploy
1. **robots.txt, sitemap.xml, llms.txt** — upload to the root of your domain (e.g. https://yourdomain.com/llms.txt).
   - WordPress: use an SEO plugin (Yoast/Rank Math) for robots & sitemap, and upload llms.txt via SFTP or a "file manager" plugin.
   - Shopify: edit robots.txt.liquid in your theme; sitemap is automatic; host llms.txt via a redirect to a file in Content → Files.
   - Webflow/Wix/Squarespace: use the platform's SEO settings for robots/sitemap; add schema via custom code.
2. **head-tags.html + schema.jsonld** — paste into the <head> of your homepage template (replace the existing title/description tags). Replace any REPLACE_ME placeholders (social profile URLs, share image).
3. **index.optimized.html** — your homepage with all fixes applied. Diff it against your source template and port the changes, or deploy it directly if your site is static.
4. **articles/** — publish each article as its own page/blog post, link to it from relevant pages, and add its JSON-LD block.
5. Validate with Google's Rich Results Test and resubmit sitemap.xml in Google Search Console and Bing Webmaster Tools.

## Still needs a human (${manual.length})
${manual.map((c) => `- **${c.title}** (${c.pillar.toUpperCase()}): ${c.recommendation}`).join('\n') || '- Nothing — great work!'}
`;
}

app.post('/api/audit/:id/chat', rateLimit(20, 60_000), async (req, res) => {
  const record = load(req, res);
  if (!record) return;
  const messages = (req.body?.messages || [])
    .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a question.' });

  const stream = sse(res);
  try {
    if (aiEnabled()) {
      await strategistReply(auditContext(record), messages, (text) => stream.send('text', { text }));
    } else {
      stream.send('text', { text: ruleStrategist(record, messages[messages.length - 1].content) });
    }
  } catch (err) {
    stream.send('error', { error: err.message });
  }
  stream.send('done', {});
  stream.end();
});

app.post('/api/audit/:id/articles', rateLimit(5, 60_000), async (req, res) => {
  const record = load(req, res);
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
    record.articles = { ...(record.articles || {}), [keyword.replace(/[^a-z0-9]+/g, '-')]: full };
  } catch (err) {
    stream.send('error', { error: err.message });
  }
  stream.send('done', {});
  stream.end();
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Rankwise running on http://localhost:${port} — AI ${aiEnabled() ? `enabled (${MODEL})` : 'disabled (set ANTHROPIC_API_KEY to enable)'}`);
});
