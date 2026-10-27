import { seoChecks } from './seo.js';
import { aeoChecks } from './aeo.js';
import { geoChecks } from './geo.js';
import { scoreChecks } from './check.js';
import { extractKeywords } from '../keywords.js';

export function runAudit(crawl) {
  const keywords = extractKeywords(crawl);
  const checks = [...seoChecks(crawl, keywords), ...aeoChecks(crawl, keywords), ...geoChecks(crawl)];
  const by = (pillar) => checks.filter((c) => c.pillar === pillar);
  const scores = { seo: scoreChecks(by('seo')), aeo: scoreChecks(by('aeo')), geo: scoreChecks(by('geo')) };
  scores.overall = Math.round(scores.seo * 0.4 + scores.aeo * 0.3 + scores.geo * 0.3);

  // Highest-impact problems first: failing, heavy-weight checks.
  const priorities = checks
    .filter((c) => c.status !== 'pass')
    .sort((a, b) => b.weight * (b.status === 'fail' ? 2 : 1) - a.weight * (a.status === 'fail' ? 2 : 1))
    .slice(0, 10);

  return {
    scores,
    checks,
    priorities,
    keywords,
    summary: {
      passed: checks.filter((c) => c.status === 'pass').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      autoFixable: checks.filter((c) => c.status !== 'pass' && c.fix === 'auto').length,
    },
  };
}

/** Compact, model-friendly snapshot of the site and audit for the AI personas. */
export function auditContext(record) {
  const { crawl, audit } = record;
  const h = crawl.home;
  return {
    site: crawl.finalUrl,
    crawledPages: crawl.pages.map((p) => ({ url: p.url, status: p.status, title: p.title, words: p.wordCount })),
    homepage: {
      title: h.title,
      metaDescription: h.metaDescription,
      h1: h.h1,
      headings: h.headings.slice(0, 30),
      schemaTypes: h.schemaTypes,
      wordCount: h.wordCount,
      openingText: h.text.slice(0, 2500),
    },
    robotsTxt: crawl.robots.body.slice(0, 1500),
    sitemap: crawl.sitemap,
    llmsTxt: crawl.llmsTxt.found,
    scores: audit.scores,
    summary: audit.summary,
    issues: audit.checks
      .filter((c) => c.status !== 'pass')
      .map(({ id, title, status, weight, detail, recommendation, fix }) => ({ id, title, status, weight, detail, recommendation, fix })),
    passing: audit.checks.filter((c) => c.status === 'pass').map((c) => c.title),
    keywords: audit.keywords.map(({ keyword, relevance, intent, inTitle, inH1 }) => ({ keyword, relevance, intent, inTitle, inH1 })),
  };
}
