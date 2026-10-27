// Keyword discovery from on-page content.
// Scores 1-3 word phrases by where they appear (title, H1, headings, meta,
// body) and how consistently they appear across the crawled pages, then
// derives question-style queries for AEO and conversational prompts for GEO.

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could did do does doing don't down during each few for from further get got had has have having he her here hers herself him himself his how i if in into is isn't it it's its itself just let's like me more most much must my myself new no nor not now of off on once one only or other our ours ourselves out over own per same she should so some such than that that's the their theirs them themselves then there there's these they this those through to too under until up us use used using very via was we were what what's when where which while who whom why will with within without would you your yours yourself yourselves our we've you're they're i'm get make made may might shall see way well back even still every next home page click here read learn more menu skip content copyright rights reserved privacy policy terms cookie cookies login log sign signup subscribe contact us email phone call today now best top inc llc ltd co www com http https html`.split(
    /\s+/,
  ),
);

// Single words too vague to target on their own.
const GENERIC_SINGLE = new Set('welcome services service products product solutions solution about blog news shop store team company business online information gallery portfolio features pricing support resources events careers'.split(' '));

const tokenize = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean);

function phrases(text, maxN = 3) {
  const tokens = tokenize(text);
  const out = [];
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (gram.some((w) => STOPWORDS.has(w))) continue;
      if (gram.some((w) => w.length < 2 || /^\d+$/.test(w))) continue;
      if (n === 1 && (gram[0].length < 4 || GENERIC_SINGLE.has(gram[0]))) continue;
      out.push(gram.join(' '));
    }
  }
  return out;
}

import { isBranded, brandName } from './brand.js';

const WEIGHTS = { title: 6, h1: 5, meta: 3, h2: 3, h3: 2, anchor: 1, body: 1 };

export function extractKeywords(crawl, limit = 15) {
  const scores = new Map();
  const pageHits = new Map();
  const zones = new Map();

  const add = (text, zone, pageIdx) => {
    for (const p of phrases(text)) {
      const words = p.split(' ').length;
      // Multi-word phrases are more specific and usually more valuable.
      const boost = words === 1 ? 0.7 : words === 2 ? 1.8 : 2.2;
      scores.set(p, (scores.get(p) || 0) + WEIGHTS[zone] * boost);
      if (!pageHits.has(p)) pageHits.set(p, new Set());
      pageHits.get(p).add(pageIdx);
      if (!zones.has(p)) zones.set(p, new Set());
      zones.get(p).add(zone);
    }
  };

  const pages = crawl.pages.filter((p) => p.status >= 200 && p.status < 400 && (p.title || p.text));
  pages.forEach((page, idx) => {
    add(page.title, 'title', idx);
    page.h1?.forEach((h) => add(h, 'h1', idx));
    add(page.metaDescription, 'meta', idx);
    page.headings?.filter((h) => h.level === 2).forEach((h) => add(h.text, 'h2', idx));
    page.headings?.filter((h) => h.level === 3).forEach((h) => add(h.text, 'h3', idx));
    add(page.text, 'body', idx);
  });

  const pageCount = Math.max(1, pages.length);
  const ranked = [...scores.entries()]
    .map(([phrase, score]) => {
      const spread = pageHits.get(phrase).size / pageCount;
      return { phrase, score: score * (0.6 + spread), spread, zones: [...zones.get(phrase)] };
    })
    .filter((k) => k.score >= 4);
  ranked.sort((a, b) => b.score - a.score);

  // Upgrade fragments ("custom wedding") to the fuller phrase they usually
  // belong to ("custom wedding cakes"), then drop overlapping duplicates.
  const byPhrase = new Map(ranked.map((k) => [k.phrase, k]));
  const upgraded = ranked.map((k) => {
    const longer = ranked
      .filter((o) => o.phrase.length > k.phrase.length && ` ${o.phrase} `.includes(` ${k.phrase} `) && o.score >= k.score * 0.55)
      .sort((a, b) => b.score - a.score)[0];
    return longer ? { ...longer, score: Math.max(longer.score, k.score) } : k;
  });
  const overlaps = (a, b) => {
    const wa = a.split(' ');
    const wb = b.split(' ');
    return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `) ||
      (wa.length > 1 && wb.length > 1 && (wa.at(-1) === wb[0] || wb.at(-1) === wa[0]) && byPhrase.has([...wa, ...wb.slice(1)].join(' ')));
  };
  upgraded.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const k of upgraded) {
    if (picked.some((p) => p.phrase === k.phrase || overlaps(p.phrase, k.phrase))) continue;
    picked.push(k);
    if (picked.length >= limit + 5) break;
  }
  // Non-branded terms first: they are the ones worth winning new traffic for.
  picked.forEach((k) => (k.branded = isBranded(k.phrase, crawl)));
  picked.sort((a, b) => Number(a.branded) - Number(b.branded) || b.score - a.score);
  picked.splice(limit);

  const max = Math.max(1, ...picked.map((k) => k.score));
  const home = crawl.home;
  return picked.map((k) => {
    const lower = (s) => String(s || '').toLowerCase();
    return {
      keyword: k.phrase,
      relevance: Math.round((k.score / max) * 100),
      intent: classifyIntent(k.phrase),
      branded: k.branded,
      inTitle: lower(home.title).includes(k.phrase),
      inH1: home.h1.some((h) => lower(h).includes(k.phrase)),
      inMeta: lower(home.metaDescription).includes(k.phrase),
      pagesUsing: Math.round(k.spread * pageCount),
      questions: questionsFor(k.phrase),
      aiPrompts: promptsFor(k.phrase, crawl),
    };
  });
}

function classifyIntent(phrase) {
  if (/\b(buy|price|pricing|cost|cheap|deal|order|hire|quote|near me|service|services|company|agency)\b/.test(phrase)) return 'transactional';
  if (/\b(best|vs|review|reviews|compare|comparison|alternative|alternatives|top)\b/.test(phrase)) return 'commercial';
  if (/\b(login|account|dashboard|contact)\b/.test(phrase)) return 'navigational';
  return 'informational';
}

function questionsFor(k) {
  const be = /s$/.test(k) && !/(ss|us|is)$/.test(k) ? 'are' : 'is';
  const does = be === 'are' ? 'do' : 'does';
  return [`What ${be} ${k}?`, `How ${does} ${k} work?`, `How much ${does} ${k} cost?`, `What are the benefits of ${k}?`, `How do I choose the right ${k}?`];
}

function promptsFor(k, crawl) {
  const brand = brandName(crawl);
  return [`Recommend the best ${k} providers`, `Explain ${k} like I'm a beginner`, `Is ${brand} a good choice for ${k}?`];
}
