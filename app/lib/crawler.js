// Crawls a site (homepage + a sample of internal pages) and extracts the
// on-page signals the SEO / AEO / GEO checks need.
import * as cheerio from 'cheerio';
import { safeFetch, normalizeUrl } from './fetcher.js';

const QUESTION_RE = /^(who|what|when|where|why|how|which|can|does|do|is|are|should|will|would)\b.*|.*\?$/i;
const DEFAULT_MAX_PAGES = Number(process.env.MAX_CRAWL_PAGES || 8);

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      jsonLd.push(...items);
    } catch {
      jsonLd.push({ '@invalid': true, raw: raw.slice(0, 200) });
    }
  });
  const schemaTypes = [
    ...new Set(
      jsonLd.flatMap((item) => {
        const t = item?.['@type'];
        return Array.isArray(t) ? t : t ? [t] : [];
      }),
    ),
  ];

  const meta = (sel) => clean($(sel).attr('content'));
  const og = {};
  $('meta[property^="og:"]').each((_, el) => (og[$(el).attr('property')] = clean($(el).attr('content'))));
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => (twitter[$(el).attr('name')] = clean($(el).attr('content'))));

  const rawHtmlLength = html.length;
  const scriptCount = $('script').length;
  const inlineScriptBytes = $('script:not([src])').text().length;

  // Strip non-content before computing text.
  const $content = cheerio.load(html);
  $content('script, style, noscript, svg, template, iframe').remove();
  const mainEl = $content('main').length ? $content('main') : $content('article').length ? $content('article') : $content('body');
  const text = clean(mainEl.text());
  const bodyText = clean($content('body').text());
  const words = bodyText ? bodyText.split(/\s+/).length : 0;

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push({ level: Number(el.tagName[1]), text: clean($(el).text()) });
  });

  // Paragraph that follows each question-style heading (AEO "answer block").
  const answerBlocks = [];
  $('h2, h3, h4').each((_, el) => {
    const q = clean($(el).text());
    if (!QUESTION_RE.test(q)) return;
    const next = $(el).nextAll('p').first();
    const answer = clean(next.text());
    answerBlocks.push({ question: q, answer, answerWords: answer ? answer.split(/\s+/).length : 0 });
  });

  const paragraphs = [];
  $content('p').each((_, el) => {
    const p = clean($content(el).text());
    if (p.length > 40) paragraphs.push(p);
  });

  const images = [];
  $('img').each((_, el) => {
    images.push({
      src: $(el).attr('src') || $(el).attr('data-src') || '',
      alt: $(el).attr('alt'),
      width: $(el).attr('width'),
      height: $(el).attr('height'),
      loading: $(el).attr('loading'),
    });
  });

  const internal = new Set();
  const external = new Set();
  let nofollowCount = 0;
  let genericAnchorCount = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    abs.hash = '';
    if (/nofollow/i.test($(el).attr('rel') || '')) nofollowCount++;
    if (/^(click here|read more|here|more|learn more|link)$/i.test(clean($(el).text()))) genericAnchorCount++;
    if (abs.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) internal.add(abs.href);
    else if (/^https?:$/.test(abs.protocol)) external.add(abs.href);
  });

  const hreflang = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => hreflang.push($(el).attr('hreflang')));

  const datePublished =
    meta('meta[property="article:published_time"]') ||
    jsonLd.map((i) => i?.datePublished).find(Boolean) ||
    clean($('time[datetime]').first().attr('datetime'));
  const dateModified =
    meta('meta[property="article:modified_time"]') || jsonLd.map((i) => i?.dateModified).find(Boolean) || '';
  const author =
    meta('meta[name="author"]') ||
    jsonLd.map((i) => (typeof i?.author === 'string' ? i.author : i?.author?.name)).find(Boolean) ||
    clean($('[rel="author"], .author, [itemprop="author"]').first().text());

  const orgSchema = jsonLd.find((i) => /Organization|LocalBusiness|Corporation/.test(String(i?.['@type'])));

  return {
    url: pageUrl,
    title: clean($('head > title').first().text() || $('title').first().text()),
    metaDescription: meta('meta[name="description"]'),
    metaRobots: meta('meta[name="robots"]').toLowerCase(),
    metaKeywords: meta('meta[name="keywords"]'),
    canonical: clean($('link[rel="canonical"]').attr('href')),
    lang: clean($('html').attr('lang')),
    viewport: meta('meta[name="viewport"]'),
    charset: Boolean($('meta[charset]').length || /charset=/i.test($('meta[http-equiv="Content-Type"]').attr('content') || '')),
    favicon: Boolean($('link[rel~="icon"]').length),
    og,
    twitter,
    jsonLd,
    schemaTypes,
    orgSameAs: orgSchema?.sameAs ? [].concat(orgSchema.sameAs) : [],
    orgName: orgSchema?.name || '',
    headings,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    answerBlocks,
    paragraphs,
    images,
    internalLinks: [...internal],
    externalLinks: [...external],
    nofollowCount,
    genericAnchorCount,
    hreflang,
    text,
    wordCount: words,
    listCount: $('ul, ol').length,
    tableCount: $('table').length,
    blockquoteCount: $('blockquote').length,
    statCount: (bodyText.match(/\b\d+(\.\d+)?\s?(%|percent|x\b|million|billion|k\b)/gi) || []).length,
    citationLinks: [...external].filter((u) => /\.(gov|edu|org)(\/|$)|wikipedia\.org|doi\.org|ncbi|who\.int/i.test(new URL(u).hostname + '/')).length,
    datePublished,
    dateModified,
    author,
    scriptCount,
    inlineScriptBytes,
    textHtmlRatio: rawHtmlLength ? bodyText.length / rawHtmlLength : 0,
    hasNoscriptContent: clean($('noscript').text()).length > 50,
    spaShell: words < 60 && scriptCount > 3 && Boolean($('#root, #app, #__next, [data-reactroot]').length),
    hasBreadcrumbsMarkup: /breadcrumb/i.test($('nav[aria-label], [class*="breadcrumb"]').attr('class') || '') || schemaTypes.includes('BreadcrumbList'),
  };
}

export function parseRobots(body) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    const stripped = line.replace(/#.*/, '').trim();
    const m = stripped.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, keyRaw, value] = m;
    const key = keyRaw.toLowerCase();
    if (key === 'sitemap') sitemaps.push(value.trim());
    else if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.trim().toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ type: key, path: value.trim() });
    }
  }
  return { groups, sitemaps };
}

/** Is `agent` fully blocked from the site root by robots.txt? */
export function robotsBlocksAgent(robots, agent) {
  if (!robots?.groups?.length) return false;
  const a = agent.toLowerCase();
  const group =
    robots.groups.find((g) => g.agents.includes(a)) || robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  const rootDisallowed = group.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const rootAllowed = group.rules.some((r) => r.type === 'allow' && r.path === '/');
  return rootDisallowed && !rootAllowed;
}

function parseSitemap(xml) {
  const $ = cheerio.load(xml || '', { xml: true });
  const urls = [];
  $('url > loc').each((_, el) => urls.push(clean($(el).text())));
  const children = [];
  $('sitemap > loc').each((_, el) => children.push(clean($(el).text())));
  return { urls, children };
}

async function fetchOptional(url) {
  try {
    const res = await safeFetch(url, { timeoutMs: 10000 });
    return res;
  } catch (err) {
    return { url: String(url), status: 0, ok: false, body: '', error: err.message, headers: {} };
  }
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function crawlSite(inputUrl, { maxPages = DEFAULT_MAX_PAGES, onProgress = () => {} } = {}) {
  const start = normalizeUrl(inputUrl);
  onProgress(`Fetching ${start.href}`);
  const home = await safeFetch(start);
  if (!home.ok) throw new Error(`The page returned HTTP ${home.status}. Check the URL and try again.`);
  if (!/html/i.test(home.headers['content-type'] || 'text/html')) {
    throw new Error(`That URL returned ${home.headers['content-type']}, not an HTML page.`);
  }
  const origin = new URL(home.url).origin;

  onProgress('Checking robots.txt, sitemap.xml and llms.txt');
  const [robotsRes, llmsRes, llmsFullRes] = await Promise.all([
    fetchOptional(`${origin}/robots.txt`),
    fetchOptional(`${origin}/llms.txt`),
    fetchOptional(`${origin}/llms-full.txt`),
  ]);
  const robots = robotsRes.ok ? parseRobots(robotsRes.body) : null;
  const sitemapUrl = robots?.sitemaps?.[0] || `${origin}/sitemap.xml`;
  let sitemapRes = await fetchOptional(sitemapUrl);
  let sitemap = sitemapRes.ok && /<(urlset|sitemapindex)/i.test(sitemapRes.body) ? parseSitemap(sitemapRes.body) : null;
  if (sitemap && !sitemap.urls.length && sitemap.children.length) {
    const child = await fetchOptional(sitemap.children[0]);
    if (child.ok) sitemap = { ...parseSitemap(child.body), children: sitemap.children };
  }

  const homePage = { ...parsePage(home.body, home.url), status: home.status, timeMs: home.timeMs, bytes: home.bytes, headers: home.headers, redirects: home.redirects };

  // Pick a sample of internal pages: homepage links first, then sitemap URLs.
  const candidates = [...new Set([...homePage.internalLinks, ...(sitemap?.urls || [])])]
    .filter((u) => u !== home.url && u.replace(/\/$/, '') !== home.url.replace(/\/$/, ''))
    .filter((u) => !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|css|js|xml)(\?|$)/i.test(u))
    .slice(0, Math.max(0, maxPages - 1));

  onProgress(`Crawling ${candidates.length} internal page(s)`);
  const subPages = await mapLimit(candidates, 4, async (u) => {
    try {
      const res = await safeFetch(u, { timeoutMs: 10000 });
      if (!/html/i.test(res.headers['content-type'] || '')) return { url: u, status: res.status, nonHtml: true };
      return { ...parsePage(res.body, res.url), status: res.status, timeMs: res.timeMs, bytes: res.bytes, redirects: res.redirects };
    } catch (err) {
      return { url: u, status: 0, error: err.message };
    }
  });

  return {
    inputUrl: start.href,
    finalUrl: home.url,
    origin,
    https: home.url.startsWith('https://'),
    home: homePage,
    homeHtml: home.body,
    pages: [homePage, ...subPages.filter((p) => !p.nonHtml)],
    robots: { found: Boolean(robots), status: robotsRes.status, body: robotsRes.body?.slice(0, 5000) || '', parsed: robots },
    sitemap: { found: Boolean(sitemap), url: sitemapUrl, status: sitemapRes.status, urlCount: sitemap?.urls.length || 0 },
    llmsTxt: { found: llmsRes.ok && llmsRes.body.trim().length > 0 && !/<html/i.test(llmsRes.body), body: llmsRes.ok ? llmsRes.body.slice(0, 3000) : '' },
    llmsFullTxt: { found: llmsFullRes.ok && !/<html/i.test(llmsFullRes.body) },
    crawledAt: new Date().toISOString(),
  };
}
