// Builds the "fix pack": corrected head tags, JSON-LD, robots.txt, sitemap.xml,
// llms.txt and a patched copy of the homepage HTML with every auto-fixable
// issue resolved. Optional `copy` (from the AI expert) upgrades the wording;
// without it, deterministic copy is derived from the page itself.
import * as cheerio from 'cheerio';
import { AI_CRAWLERS } from './audit/geo.js';
import { brandName } from './brand.js';

export { brandName };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

/** Pull the sentence(s) on the site that best answer a question about `keyword`. */
function extractAnswer(crawl, keyword, used) {
  const sentences = crawl.pages
    .filter((p) => p.status < 400)
    .flatMap((p) => p.paragraphs || [])
    .flatMap((p) => p.match(/[^.!?]+[.!?]+/g) || [p])
    .map((s) => s.trim())
    .filter((s) => !used.has(s));
  const hits = sentences.filter((s) => s.toLowerCase().includes(keyword.toLowerCase()));
  const chosen = hits.slice(0, 2);
  chosen.forEach((s) => used.add(s));
  return truncate(chosen.join(' '), 320);
}

export function deterministicCopy(crawl, audit) {
  const h = crawl.home;
  const brand = brandName(crawl);
  const generic = audit.keywords.filter((k) => !k.branded);
  const kw = generic[0]?.keyword || audit.keywords[0]?.keyword || brand;
  const kw2 = generic[1]?.keyword;
  const goodTitle = h.title && h.title.length >= 30 && h.title.length <= 60 && h.title.toLowerCase().includes(kw);
  let title = goodTitle ? h.title : `${titleCase(kw)}${kw2 ? ` & ${titleCase(kw2)}` : ''} | ${brand}`;
  if (title.length > 60) title = truncate(`${titleCase(kw)} | ${brand}`, 60);
  const lead = h.paragraphs[0] || h.text.slice(0, 300);
  const goodDesc = h.metaDescription && h.metaDescription.length >= 70 && h.metaDescription.length <= 160 && h.metaDescription.toLowerCase().includes(kw);
  let metaDescription = goodDesc ? h.metaDescription : lead.toLowerCase().includes(kw) ? lead : `${titleCase(kw)} from ${brand}. ${lead}`;
  if (metaDescription.length > 160) metaDescription = truncate(metaDescription, 155);

  const used = new Set();
  // "What is X?" is the one question an extracted on-site sentence reliably answers.
  const faqs = generic.slice(0, 6)
    .map((k) => ({ question: k.questions[0], answer: extractAnswer(crawl, k.keyword, used) }))
    .filter((f) => f.answer.length > 30)
    .slice(0, 5);

  return {
    title,
    metaDescription,
    h1: h.h1.length === 1 && !/^(home|welcome)$/i.test(h.h1[0]) ? h.h1[0] : `${titleCase(kw)} — ${brand}`,
    orgDescription: truncate(lead || metaDescription, 250),
    faqs,
    source: 'rules',
  };
}

function buildJsonLd(crawl, copy) {
  const h = crawl.home;
  const origin = crawl.origin;
  const brand = brandName(crawl);
  const logo = h.og['og:image'] || `${origin}/favicon.ico`;
  const existing = new Set(h.schemaTypes);
  const graph = [];

  if (![...existing].some((t) => /Organization|LocalBusiness|Corporation/.test(t)) || !h.orgSameAs.length) {
    graph.push({
      '@type': 'Organization',
      '@id': `${origin}/#organization`,
      name: brand,
      url: `${origin}/`,
      logo,
      description: copy.orgDescription,
      sameAs: h.orgSameAs.length ? h.orgSameAs : ['https://www.linkedin.com/company/REPLACE_ME', 'https://x.com/REPLACE_ME', 'https://www.facebook.com/REPLACE_ME'],
    });
  }
  if (!existing.has('WebSite')) {
    graph.push({ '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: brand, publisher: { '@id': `${origin}/#organization` } });
  }
  graph.push({
    '@type': 'WebPage',
    '@id': `${crawl.finalUrl}#webpage`,
    url: crawl.finalUrl,
    name: copy.title,
    description: copy.metaDescription,
    isPartOf: { '@id': `${origin}/#website` },
    about: { '@id': `${origin}/#organization` },
    dateModified: new Date().toISOString().slice(0, 10),
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.rw-summary', '.rw-faq'] },
  });
  if (!existing.has('BreadcrumbList')) {
    graph.push({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` }] });
  }
  if (copy.faqs.length && !existing.has('FAQPage')) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: copy.faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

function buildRobots(crawl) {
  const sitemapLine = `Sitemap: ${crawl.origin}/sitemap.xml`;
  const searchBots = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot'];
  const existing = crawl.robots.found ? crawl.robots.body : '';
  // Drop root-level blocks that target AI search bots or everything.
  const lines = existing.split(/\r?\n/);
  let agents = [];
  let lastWasAgent = false;
  const kept = [];
  for (const line of lines) {
    const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i);
    const isAgent = m && m[1].toLowerCase() === 'user-agent';
    if (isAgent) {
      if (!lastWasAgent) agents = [];
      agents.push(m[2].trim().toLowerCase());
    }
    if (line.trim()) lastWasAgent = Boolean(isAgent);
    const blocksRoot = m && m[1].toLowerCase() === 'disallow' && m[2].trim() === '/';
    const targetsSearch = agents.some((a) => a === '*' || searchBots.map((b) => b.toLowerCase()).includes(a));
    if (blocksRoot && targetsSearch) {
      kept.push(`# ${line.trim()}  <- removed by Rankwise: blocked search/AI answer engines`);
      continue;
    }
    if (/^\s*sitemap\s*:/i.test(line)) continue;
    kept.push(line);
  }
  const body = kept.join('\n').trim() || 'User-agent: *\nAllow: /';
  const aiBlock = AI_CRAWLERS.map((b) => `User-agent: ${b.agent}`).join('\n');
  return `${body}\n\n# Allow AI search & answer engines to read and cite this site (GEO)\n${aiBlock}\nAllow: /\n\n${sitemapLine}\n`;
}

function buildSitemap(crawl) {
  const urls = [...new Set(crawl.pages.filter((p) => p.status >= 200 && p.status < 400 && !/noindex/.test(p.metaRobots || '')).map((p) => p.canonical || p.url))];
  const today = new Date().toISOString().slice(0, 10);
  const entries = urls
    .map((u, i) => `  <url>\n    <loc>${esc(u)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${i === 0 ? '1.0' : '0.8'}</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function buildLlmsTxt(crawl, audit, copy) {
  const brand = brandName(crawl);
  const pages = crawl.pages.filter((p) => p.title && p.status < 400).slice(0, 20);
  const kws = audit.keywords.slice(0, 8).map((k) => k.keyword).join(', ');
  return `# ${brand}

> ${copy.orgDescription}

${brand} focuses on: ${kws}.

## Key pages

${pages.map((p) => `- [${p.title}](${p.url})${p.metaDescription ? `: ${truncate(p.metaDescription, 140)}` : ''}`).join('\n')}

## Frequently asked questions

${copy.faqs.map((f) => `- **${f.question}** ${f.answer}`).join('\n')}

## Optional

- [Sitemap](${crawl.origin}/sitemap.xml)
`;
}

function headTags(crawl, copy) {
  const h = crawl.home;
  const canonical = h.canonical || crawl.finalUrl;
  const image = h.og['og:image'] || '';
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(copy.title)}</title>`,
    `<meta name="description" content="${esc(copy.metaDescription)}">`,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(brandName(crawl))}">`,
    `<meta property="og:title" content="${esc(copy.title)}">`,
    `<meta property="og:description" content="${esc(copy.metaDescription)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '<meta property="og:image" content="https://REPLACE_WITH_1200x630_SHARE_IMAGE.jpg">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(copy.title)}">`,
    `<meta name="twitter:description" content="${esc(copy.metaDescription)}">`,
    h.favicon ? '' : '<link rel="icon" href="/favicon.ico">',
  ].filter(Boolean).join('\n');
}

function altFromSrc(src, fallback) {
  const file = String(src).split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '');
  const words = file.replace(/[-_]+/g, ' ').replace(/\d{2,}/g, '').trim();
  return words.length > 2 ? titleCase(words) : fallback;
}

function patchHtml(crawl, copy, jsonLd) {
  const $ = cheerio.load(crawl.homeHtml);
  const changes = [];
  const h = crawl.home;
  if (!$('head').length) $('html').prepend('<head></head>');
  const head = $('head');

  if (!$('html').attr('lang')) { $('html').attr('lang', 'en'); changes.push('Added lang="en" to <html>'); }
  if (!$('meta[charset]').length) { head.prepend('<meta charset="utf-8">'); changes.push('Declared UTF-8 charset'); }
  if (!$('meta[name="viewport"]').length) { head.append('\n<meta name="viewport" content="width=device-width, initial-scale=1">'); changes.push('Added mobile viewport tag'); }

  if (h.title !== copy.title) {
    if ($('title').length) $('title').first().text(copy.title); else head.append(`\n<title>${esc(copy.title)}</title>`);
    changes.push(`Title: "${h.title || '(none)'}" → "${copy.title}"`);
  }
  if (h.metaDescription !== copy.metaDescription) {
    if ($('meta[name="description"]').length) $('meta[name="description"]').attr('content', copy.metaDescription);
    else head.append(`\n<meta name="description" content="${esc(copy.metaDescription)}">`);
    changes.push('Rewrote meta description');
  }
  const robots = $('meta[name="robots"]');
  if (robots.length && /noindex/i.test(robots.attr('content'))) { robots.attr('content', 'index, follow, max-image-preview:large, max-snippet:-1'); changes.push('Removed noindex so the page can rank'); }
  if (!$('link[rel="canonical"]').length) { head.append(`\n<link rel="canonical" href="${esc(crawl.finalUrl)}">`); changes.push('Added self-referencing canonical'); }

  const ogWanted = { 'og:type': 'website', 'og:title': copy.title, 'og:description': copy.metaDescription, 'og:url': crawl.finalUrl, 'og:site_name': brandName(crawl) };
  let ogAdded = 0;
  for (const [prop, val] of Object.entries(ogWanted)) {
    if (!$(`meta[property="${prop}"]`).length) { head.append(`\n<meta property="${prop}" content="${esc(val)}">`); ogAdded++; }
  }
  if (!$('meta[name="twitter:card"]').length) { head.append('\n<meta name="twitter:card" content="summary_large_image">'); ogAdded++; }
  if (ogAdded) changes.push(`Added ${ogAdded} Open Graph / Twitter tag(s)`);
  if (!$('link[rel~="icon"]').length) { head.append('\n<link rel="icon" href="/favicon.ico">'); changes.push('Linked favicon'); }

  head.append(`\n<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>\n`);
  changes.push(`Added JSON-LD: ${jsonLd['@graph'].map((g) => g['@type']).join(', ')}`);

  const h1s = $('h1');
  if (!h1s.length) {
    ($('main').length ? $('main') : $('body')).prepend(`<h1>${esc(copy.h1)}</h1>\n`);
    changes.push(`Added H1: "${copy.h1}"`);
  } else if (h1s.length > 1) {
    h1s.slice(1).each((_, el) => { el.tagName = 'h2'; });
    changes.push(`Demoted ${h1s.length - 1} extra H1(s) to H2`);
  }

  let alts = 0;
  let lazy = 0;
  $('img').each((i, el) => {
    const img = $(el);
    if (img.attr('alt') === undefined || img.attr('alt').trim() === '') {
      img.attr('alt', altFromSrc(img.attr('src') || '', `${brandName(crawl)} image ${i + 1}`));
      alts++;
    }
    if (i > 1 && !img.attr('loading')) { img.attr('loading', 'lazy'); lazy++; }
  });
  if (alts) changes.push(`Wrote alt text for ${alts} image(s) — review for accuracy`);
  if (lazy) changes.push(`Lazy-loaded ${lazy} below-the-fold image(s)`);

  if (copy.faqs.length && !h.schemaTypes.includes('FAQPage')) {
    const faqHtml = `
<section class="rw-faq" aria-labelledby="rw-faq-title">
  <h2 id="rw-faq-title">Frequently asked questions</h2>
${copy.faqs.map((f) => `  <h3>${esc(f.question)}</h3>\n  <p>${esc(f.answer)}</p>`).join('\n')}
</section>
`;
    const container = $('main').length ? $('main').first() : $('body');
    container.append(faqHtml);
    changes.push(`Added visible FAQ section with ${copy.faqs.length} question(s) (matches FAQPage schema)`);
  }

  return { html: $.html(), changes };
}

export function buildFixPack(crawl, audit, copy = deterministicCopy(crawl, audit)) {
  const jsonLd = buildJsonLd(crawl, copy);
  const { html, changes } = patchHtml(crawl, copy, jsonLd);
  const files = {
    'index.optimized.html': html,
    'head-tags.html': headTags(crawl, copy),
    'schema.jsonld': JSON.stringify(jsonLd, null, 2),
    'robots.txt': buildRobots(crawl),
    'sitemap.xml': buildSitemap(crawl),
    'llms.txt': buildLlmsTxt(crawl, audit, copy),
  };
  const fixedIds = audit.checks.filter((c) => c.status !== 'pass' && c.fix === 'auto').map((c) => c.id);
  return { copy, files, changes, fixedIds };
}
