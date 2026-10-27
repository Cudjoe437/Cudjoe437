# Rankwise: SEO, AEO and GEO website auditor

A customer enters their website URL. Rankwise crawls it, runs 52 technical checks, and reports the results. It also generates the fixes and writes keyword-targeted articles.

| Pillar | What it measures |
|---|---|
| **SEO** (Search Engine Optimization) | Crawlability, indexing, on-page tags, headings, content depth, images, speed, compression, social tags, structured data |
| **AEO** (Answer Engine Optimization) | Question headings, snippet-length answers, FAQ/HowTo/Breadcrumb schema, lists and tables, definitions, voice/speakable |
| **GEO** (Generative Engine Optimization) | AI crawler access in robots.txt (GPTBot, ClaudeBot, PerplexityBot, …), `llms.txt`, server-rendered content, Organization entity and `sameAs`, author/E-E-A-T, freshness, statistics, citations, quotes, depth |

## The AI team (powered by Claude)

1. **Senior SEO, AEO and GEO Expert** reviews the technical audit. It writes an executive summary, lists findings ranked by severity (evidence, why it matters, fix, effort), suggests quick wins, lays out a phased roadmap and maps each keyword to a page. It also writes optimized copy: title, meta description, H1, and FAQs.
2. **Strategist** is a streaming chat grounded in the customer's audit. It explains each result in plain language, helps the customer weigh trade-offs, and gives step-by-step instructions for their platform (WordPress, Shopify, Webflow and others).
3. **Content Writer** writes 1,200–1,800-word articles for any keyword the audit found. Each article includes SEO front matter, a snippet-ready answer up front, question headings, lists and tables, an FAQ section, and FAQPage and Article JSON-LD.

## The fix pack ("solve the customer's issue")

Rankwise generates every auto-fixable correction and re-audits the result to show the projected score uplift:

- `index.optimized.html`: the homepage with fixes applied (title, meta description, canonical, viewport, lang, Open Graph and Twitter tags, a single H1, alt text, lazy loading, noindex removed, JSON-LD, and a visible FAQ section)
- `head-tags.html` and `schema.jsonld`: paste-ready `<head>` tags and Organization, WebSite, WebPage, Breadcrumb and FAQPage schema
- `robots.txt`: existing rules kept, AI search engines allowed, sitemap declared
- `sitemap.xml` and `llms.txt`
- `IMPLEMENTATION.md`: deployment steps per platform, plus the checks that still need a human

You can download everything as one `.zip`, including the articles you generated. Rankwise produces the files. It cannot change a customer's live site.

## Run it

```bash
cd app
npm install
cp .env.example .env    # add ANTHROPIC_API_KEY
npm start               # http://localhost:3000
```

Without `ANTHROPIC_API_KEY`, the app runs in **offline mode**. It uses a rules-based expert review, a rules-based strategist and article templates. The crawl, audit, keywords and fix pack work either way.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude-powered expert, strategist and writer |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for all three personas |
| `PORT` | `3000` | HTTP port |
| `MAX_CRAWL_PAGES` | `8` | Pages crawled per audit (homepage + internal sample) |
| `AI_DISABLED` | — | Set to `1` to force offline mode |
| `ALLOW_PRIVATE_HOSTS` | — | Set to `1` only for local testing; allows crawling private/localhost addresses |

## Tests

```bash
npm test
```

The tests crawl a deliberately broken local fixture site in `test/fixture`. They check that the audit flags the problems, that the fix pack resolves them, and that every pillar's score improves after the fixes.

## How it works

```
server.js              Express API (SSE streaming for audit progress, chat and articles)
lib/fetcher.js         Safe fetching: SSRF protection on every redirect hop, timeouts, size cap
lib/crawler.js         Homepage + internal pages, robots.txt, sitemap.xml, llms.txt; on-page extraction
lib/audit/             SEO, AEO and GEO checks and weighted scoring
lib/keywords.js        Keyword discovery (weighted n-grams by page zone and cross-page spread)
lib/fixer.js           Fix pack generation and patched HTML
lib/ai.js              Claude personas (structured output for the review, streaming for chat and articles)
lib/fallback.js        Offline rules-based personas
public/                Single-page front end
```

Keywords come from the site's own content. Rankwise has no access to search volume, rankings, traffic or backlink data. Connect a keyword data provider if you need those.
