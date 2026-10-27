// Technical & on-page SEO checks.
import { check } from './check.js';

export function seoChecks(crawl, keywords) {
  const h = crawl.home;
  const pages = crawl.pages.filter((p) => p.title !== undefined);
  const top = keywords[0]?.keyword;
  const out = [];
  const add = (...args) => out.push(check('seo', ...args));

  // --- Crawlability & indexing
  add('https', 'Crawlability', 'Site served over HTTPS', crawl.https ? 'pass' : 'fail', 5,
    crawl.https ? 'The page loads over HTTPS.' : 'The page loads over plain HTTP.',
    'Install a TLS certificate and 301-redirect all HTTP URLs to HTTPS.', 'manual');

  const blocked = /noindex/.test(h.metaRobots) || /noindex/i.test(h.headers?.['x-robots-tag'] || '');
  add('indexable', 'Crawlability', 'Homepage is indexable', blocked ? 'fail' : 'pass', 5,
    blocked ? `A noindex directive was found (${h.metaRobots || h.headers['x-robots-tag']}).` : 'No noindex directive found.',
    'Remove the noindex meta tag / X-Robots-Tag header from pages you want ranked.', 'auto');

  add('robots-txt', 'Crawlability', 'robots.txt present', crawl.robots.found ? 'pass' : 'warn', 3,
    crawl.robots.found ? 'robots.txt was found.' : `No robots.txt (HTTP ${crawl.robots.status}).`,
    'Publish a robots.txt that allows crawling and points to your sitemap.', 'auto');

  add('sitemap', 'Crawlability', 'XML sitemap available', crawl.sitemap.found ? 'pass' : 'fail', 4,
    crawl.sitemap.found ? `Sitemap found with ${crawl.sitemap.urlCount} URL(s).` : `No XML sitemap at ${crawl.sitemap.url}.`,
    'Generate sitemap.xml listing every indexable URL and reference it in robots.txt and Google Search Console.', 'auto');

  const sitemapInRobots = Boolean(crawl.robots.parsed?.sitemaps?.length);
  add('sitemap-in-robots', 'Crawlability', 'Sitemap referenced in robots.txt', sitemapInRobots ? 'pass' : 'warn', 2,
    sitemapInRobots ? 'robots.txt declares a Sitemap.' : 'robots.txt does not declare a Sitemap line.',
    'Add "Sitemap: https://yourdomain.com/sitemap.xml" to robots.txt.', 'auto');

  const canonicalOk = h.canonical && (() => { try { return new URL(h.canonical, h.url).origin === new URL(h.url).origin; } catch { return false; } })();
  add('canonical', 'Crawlability', 'Canonical tag set', canonicalOk ? 'pass' : h.canonical ? 'warn' : 'fail', 3,
    h.canonical ? `Canonical: ${h.canonical}` : 'No rel="canonical" tag on the homepage.',
    'Add a self-referencing canonical tag to every page to consolidate duplicate URLs.', 'auto');

  const redirectHops = h.redirects?.length || 0;
  add('redirects', 'Crawlability', 'Minimal redirect chain', redirectHops <= 1 ? 'pass' : 'warn', 2,
    redirectHops ? `${redirectHops} redirect hop(s): ${h.redirects.map((r) => `${r.status}`).join(' → ')}` : 'No redirects.',
    'Link directly to the final URL and keep redirect chains to a single 301.', 'manual');

  const broken = crawl.pages.filter((p) => p.status === 0 || p.status >= 400);
  add('broken-pages', 'Crawlability', 'No broken internal pages', broken.length ? 'fail' : 'pass', 4,
    broken.length ? `${broken.length} crawled URL(s) failed: ${broken.slice(0, 3).map((b) => `${b.url} (${b.status || b.error})`).join(', ')}` : `All ${crawl.pages.length} crawled pages responded successfully.`,
    'Fix or 301-redirect broken URLs and update internal links pointing to them.', 'manual');

  // --- On-page
  const tLen = h.title.length;
  add('title', 'On-page', 'Title tag length (30–60 chars)', !tLen ? 'fail' : tLen >= 30 && tLen <= 60 ? 'pass' : 'warn', 5,
    tLen ? `"${h.title}" (${tLen} chars)` : 'The homepage has no <title>.',
    'Write a unique 30–60 character title that leads with the primary keyword and ends with the brand.', 'auto');

  if (top) {
    add('title-keyword', 'On-page', 'Primary keyword in title', h.title.toLowerCase().includes(top) ? 'pass' : 'warn', 4,
      `Primary keyword detected: "${top}".`, `Include "${top}" near the start of the title tag.`, 'auto');
  }

  const dLen = h.metaDescription.length;
  add('meta-description', 'On-page', 'Meta description (70–160 chars)', !dLen ? 'fail' : dLen >= 70 && dLen <= 160 ? 'pass' : 'warn', 4,
    dLen ? `${dLen} chars: "${h.metaDescription.slice(0, 120)}${dLen > 120 ? '…' : ''}"` : 'No meta description.',
    'Write a compelling 140–160 character description with the primary keyword and a call to action.', 'auto');

  add('h1', 'On-page', 'Exactly one H1', h.h1.length === 1 ? 'pass' : h.h1.length ? 'warn' : 'fail', 4,
    h.h1.length ? `${h.h1.length} H1(s): ${h.h1.map((x) => `"${x}"`).join(', ').slice(0, 160)}` : 'No H1 heading found.',
    'Use a single descriptive H1 containing the primary keyword.', 'auto');

  const levels = h.headings.map((x) => x.level);
  const skipped = levels.some((l, i) => i > 0 && l - levels[i - 1] > 1);
  add('heading-hierarchy', 'On-page', 'Logical heading hierarchy', skipped ? 'warn' : levels.length > 2 ? 'pass' : 'warn', 2,
    skipped ? 'Heading levels are skipped (e.g. H2 → H4).' : `${levels.length} headings found.`,
    'Structure content H1 → H2 → H3 without skipping levels; use H2s for each major subtopic.', 'manual');

  add('word-count', 'Content', 'Sufficient content depth (300+ words)', h.wordCount >= 600 ? 'pass' : h.wordCount >= 300 ? 'warn' : 'fail', 4,
    `${h.wordCount} words on the homepage.`,
    'Expand thin pages with original, helpful content answering what customers ask.', 'manual');

  const imgs = h.images;
  const missingAlt = imgs.filter((i) => i.alt === undefined || i.alt.trim() === '');
  add('img-alt', 'On-page', 'Images have alt text', !imgs.length || !missingAlt.length ? 'pass' : missingAlt.length / imgs.length > 0.3 ? 'fail' : 'warn', 3,
    imgs.length ? `${missingAlt.length} of ${imgs.length} images missing alt text.` : 'No images on the page.',
    'Describe every meaningful image in its alt attribute (and use alt="" for decorative ones).', 'auto');

  const lazy = imgs.filter((i) => i.loading === 'lazy').length;
  add('img-lazy', 'Performance', 'Images lazy-loaded', imgs.length <= 3 || lazy >= imgs.length / 2 ? 'pass' : 'warn', 1,
    `${lazy} of ${imgs.length} images use loading="lazy".`,
    'Add loading="lazy" to below-the-fold images and width/height to prevent layout shift.', 'auto');

  add('internal-links', 'On-page', 'Internal linking', h.internalLinks.length >= 5 ? 'pass' : 'warn', 3,
    `${h.internalLinks.length} internal link(s) on the homepage.`,
    'Link to key pages with descriptive anchor text so crawlers can discover and understand them.', 'manual');

  add('anchor-text', 'On-page', 'Descriptive anchor text', h.genericAnchorCount ? 'warn' : 'pass', 1,
    h.genericAnchorCount ? `${h.genericAnchorCount} link(s) use generic text like "click here".` : 'No generic anchor text found.',
    'Replace "click here"/"read more" with keyword-descriptive anchors.', 'manual');

  // --- Duplicate metadata across crawled pages
  const titles = pages.map((p) => p.title).filter(Boolean);
  const dupTitles = titles.length - new Set(titles).size;
  add('duplicate-titles', 'On-page', 'Unique titles across pages', dupTitles ? 'warn' : 'pass', 3,
    dupTitles ? `${dupTitles} duplicate title(s) among ${titles.length} crawled pages.` : `${titles.length} crawled pages have unique titles.`,
    'Give every page a unique title and meta description that reflects its own topic.', 'manual');

  // --- Technical
  add('viewport', 'Technical', 'Mobile viewport meta tag', h.viewport ? 'pass' : 'fail', 4,
    h.viewport ? `viewport: ${h.viewport}` : 'No viewport meta tag — the page will not render well on phones.',
    'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 'auto');

  add('lang', 'Technical', 'HTML lang attribute', h.lang ? 'pass' : 'warn', 2,
    h.lang ? `lang="${h.lang}"` : 'No lang attribute on <html>.', 'Declare the page language, e.g. <html lang="en">.', 'auto');

  add('charset', 'Technical', 'Character encoding declared', h.charset ? 'pass' : 'warn', 1,
    h.charset ? 'Charset is declared.' : 'No <meta charset>.', 'Add <meta charset="utf-8"> as the first element in <head>.', 'auto');

  add('favicon', 'Technical', 'Favicon present', h.favicon ? 'pass' : 'warn', 1,
    h.favicon ? 'Favicon link found.' : 'No favicon link tag.', 'Add a favicon; Google shows it next to mobile results.', 'auto');

  const ms = h.timeMs;
  add('response-time', 'Performance', 'Server response time', ms < 800 ? 'pass' : ms < 2000 ? 'warn' : 'fail', 3,
    `HTML document loaded in ${ms} ms.`,
    'Use caching/CDN, compress responses and reduce server work to get TTFB under 800 ms.', 'manual');

  const kb = Math.round(h.bytes / 1024);
  add('page-weight', 'Performance', 'HTML document size', kb < 200 ? 'pass' : kb < 500 ? 'warn' : 'fail', 2,
    `HTML is ${kb} KB.`, 'Trim inline scripts/styles and unused markup.', 'manual');

  const enc = h.headers?.['content-encoding'];
  add('compression', 'Performance', 'Text compression', enc ? 'pass' : 'warn', 2,
    enc ? `Content-Encoding: ${enc}` : 'Response is not compressed.', 'Enable gzip or Brotli on the server/CDN.', 'manual');

  // --- Social
  const ogOk = h.og['og:title'] && h.og['og:description'] && h.og['og:image'];
  add('open-graph', 'Social', 'Open Graph tags', ogOk ? 'pass' : Object.keys(h.og).length ? 'warn' : 'fail', 2,
    Object.keys(h.og).length ? `Found: ${Object.keys(h.og).join(', ')}` : 'No Open Graph tags.',
    'Add og:title, og:description, og:image, og:url and og:type for rich link previews.', 'auto');

  add('twitter-card', 'Social', 'Twitter/X card tags', h.twitter['twitter:card'] ? 'pass' : 'warn', 1,
    h.twitter['twitter:card'] ? `twitter:card = ${h.twitter['twitter:card']}` : 'No twitter:card tag.',
    'Add twitter:card="summary_large_image" plus title/description/image.', 'auto');

  add('structured-data', 'Technical', 'Structured data (JSON-LD)', h.schemaTypes.length ? 'pass' : 'fail', 4,
    h.schemaTypes.length ? `Schema types: ${h.schemaTypes.join(', ')}` : 'No JSON-LD structured data found.',
    'Add Organization, WebSite and page-specific schema (Article, Product, FAQPage, LocalBusiness).', 'auto');

  const invalidLd = h.jsonLd.filter((x) => x['@invalid']).length;
  if (invalidLd) {
    add('structured-data-valid', 'Technical', 'JSON-LD parses correctly', 'fail', 3,
      `${invalidLd} JSON-LD block(s) contain invalid JSON.`, 'Fix the syntax so search engines can read the markup.', 'auto');
  }

  return out;
}
