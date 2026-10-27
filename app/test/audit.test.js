import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlSite, parsePage, parseRobots, robotsBlocksAgent } from '../lib/crawler.js';
import { runAudit } from '../lib/audit/index.js';
import { buildFixPack } from '../lib/fixer.js';
import { ruleReview, ruleStrategist, templateArticle } from '../lib/fallback.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
let server;
let base;

before(async () => {
  server = http.createServer(async (req, res) => {
    let file = path.join(fixtureDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (file.endsWith('/')) file += 'index.html';
    try {
      const body = await fs.readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain';
      res.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

const withPrivate = async (fn) => {
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  try {
    return await fn();
  } finally {
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
};

test('refuses to crawl private network addresses', async () => {
  await assert.rejects(crawlSite('http://127.0.0.1:1/'), /private/);
  await assert.rejects(crawlSite('http://localhost/'), /private/);
});

test('robots parser detects AI crawler blocks', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n');
  assert.equal(robotsBlocksAgent(robots, 'GPTBot'), true);
  assert.equal(robotsBlocksAgent(robots, 'CCBot'), true);
  assert.equal(robotsBlocksAgent(robots, 'ClaudeBot'), false);
});

test('parsePage extracts question/answer blocks', () => {
  const page = parsePage('<html><body><h2>What is a sourdough starter?</h2><p>A sourdough starter is a live culture of flour and water that leavens bread naturally without commercial yeast.</p></body></html>', 'https://a.com/');
  assert.equal(page.answerBlocks.length, 1);
  assert.ok(page.answerBlocks[0].answerWords > 10);
});

test('full audit → fixes → projected uplift on the fixture site', async () => {
  const crawl = await withPrivate(() => crawlSite(base));
  assert.equal(crawl.pages.length >= 3, true, 'crawls internal pages');
  const audit = runAudit(crawl);
  const status = (id) => audit.checks.find((c) => c.id === id)?.status;

  assert.equal(status('seo:indexable'), 'fail');
  assert.equal(status('seo:h1'), 'warn');
  assert.equal(status('seo:sitemap'), 'fail');
  assert.equal(status('seo:broken-pages'), 'fail');
  assert.equal(status('seo:structured-data-valid'), 'fail');
  assert.equal(status('geo:ai-crawlers'), 'fail');
  assert.equal(status('geo:llms-txt'), 'fail');
  assert.equal(status('aeo:faq-schema'), 'fail');
  assert.ok(audit.keywords.some((k) => /wedding cakes?/.test(k.keyword)), `keywords: ${audit.keywords.map((k) => k.keyword)}`);

  const pack = buildFixPack(crawl, audit);
  const html = pack.files['index.optimized.html'];
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /noindex/);
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /"@type": "FAQPage"/);
  assert.match(html, /class="rw-faq"/);
  assert.match(pack.files['robots.txt'], /removed by Rankwise/);
  assert.match(pack.files['robots.txt'], /Sitemap: /);
  assert.equal(robotsBlocksAgent(parseRobots(pack.files['robots.txt']), 'PerplexityBot'), false);
  assert.match(pack.files['sitemap.xml'], /<urlset/);
  assert.doesNotMatch(pack.files['sitemap.xml'], /missing\.html/);
  assert.match(pack.files['llms.txt'], /^# /);

  // Re-audit the patched homepage
  const fixedHome = { ...parsePage(html, crawl.finalUrl), status: 200, timeMs: crawl.home.timeMs, bytes: html.length, headers: crawl.home.headers, redirects: [] };
  const robotsBody = pack.files['robots.txt'];
  const after = runAudit({
    ...crawl,
    home: fixedHome,
    pages: [fixedHome, ...crawl.pages.slice(1)],
    robots: { found: true, body: robotsBody, parsed: parseRobots(robotsBody) },
    sitemap: { found: true, urlCount: 3 },
    llmsTxt: { found: true },
  });
  for (const pillar of ['seo', 'aeo', 'geo', 'overall']) {
    assert.ok(after.scores[pillar] > audit.scores[pillar], `${pillar}: ${audit.scores[pillar]} → ${after.scores[pillar]}`);
  }

  const record = { crawl, audit };
  const review = ruleReview(record);
  assert.ok(review.findings.length > 0 && review.optimizedCopy.title);
  assert.match(ruleStrategist(record, 'what is my score?'), /overall score/);
  assert.match(templateArticle(record, 'custom wedding cakes', []), /# Custom Wedding Cakes/);
});
