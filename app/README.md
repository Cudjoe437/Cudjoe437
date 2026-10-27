# Rankwise: SEO, AEO and GEO audits with live fixes

Rankwise is a complete SaaS for search visibility. A customer signs up and enters their website URL. Rankwise audits the site, explains the results, puts the fixes live on the customer's site, and then proves they worked.

**Audit → Understand → Fix live → Verify → Track over time**

| Pillar | What it measures |
|---|---|
| **SEO** (Search Engine Optimization) | Crawlability, indexing, on-page tags, headings, content depth, images, speed, compression, social tags, structured data |
| **AEO** (Answer Engine Optimization) | Question headings, snippet-length answers, FAQ/HowTo/Breadcrumb schema, lists and tables, definitions, voice/speakable |
| **GEO** (Generative Engine Optimization) | AI crawler access (GPTBot, ClaudeBot, PerplexityBot, …), `llms.txt`, server-rendered content, Organization entity and `sameAs`, author/E-E-A-T, freshness, statistics, citations, quotes, depth |

## The customer journey

1. **Sign up.** Email and password. The Free plan includes 3 audits a month. Pro is a Stripe subscription.
2. **Audit.** Rankwise crawls the homepage and a sample of internal pages, plus `robots.txt`, `sitemap.xml` and `llms.txt`. It runs 52 checks, scores SEO, AEO and GEO, and finds the site's top keywords. Every audit is saved to the customer's site history.
3. **Understand.**
   - The **Senior SEO, AEO and GEO Expert** (Claude) writes the review: an executive summary, prioritised findings with evidence, quick wins, a roadmap, a keyword strategy and rewritten copy.
   - The **Strategist** (Claude) is a chat grounded in the customer's audit. It gives platform-specific instructions, and conversations are saved.
4. **Fix live.** The **Go live** tab has three ways to apply the fixes:
   - **One-line snippet** that works on any platform. The customer clicks **Publish fixes** and adds `<script src="https://<your-app>/s/<key>.js" async></script>` to their `<head>` once. The snippet then applies the corrected title, meta description, robots, canonical, Open Graph and Twitter tags, JSON-LD (Organization, WebSite, WebPage, Breadcrumb, FAQPage), alt text, a single H1 and a visible FAQ section. Republishing updates the live site without touching its code again. Each platform (WordPress, Shopify, Webflow, Wix, Squarespace) has its own install instructions.
   - **WordPress auto-publishing.** The customer connects with an Application Password, which is verified and stored encrypted. Rankwise can then publish an FAQ page with FAQPage schema and send the AI articles as drafts or published posts (with Yoast or Rank Math meta when those plugins are present).
   - **Root files.** `robots.txt`, `sitemap.xml` and `llms.txt` are ready to download, along with the full fix pack as a `.zip`.
5. **Verify.** **Verify live site** re-audits the site. When the snippet is detected, Rankwise audits the page twice:
   - **as Google renders it**, with the fixes applied
   - **as raw HTML**, which is what most AI crawlers read

   It then shows which checks were **fixed**, **regressed** or are **still open** since the last audit.
6. **Grow.** The **Content Writer** (Claude) turns any discovered keyword into a 1,200–1,800-word article built for SEO, AEO and GEO. Articles are saved per site and can be published to WordPress.
7. **Track.** The dashboard shows each site's latest score and trend. The site page charts the score history and lists every audit.

## Run locally

```bash
cd app
npm install
cp .env.example .env    # add ANTHROPIC_API_KEY (optional) and APP_SECRET
npm start               # http://localhost:3000
```

- **Without `ANTHROPIC_API_KEY`:** the expert, strategist and writer fall back to a rules engine and article templates.
- **Without Stripe keys:** the app runs in **demo mode**. Billing is off and every account gets Pro features, which is shown in the UI.

## Deploy

**Render (one click).** The repo root contains `render.yaml`. In Render, choose **New → Blueprint** and select this repository. It builds `app/Dockerfile`, mounts a persistent disk at `/data` for the SQLite database, and generates `APP_SECRET`. Fill in `ANTHROPIC_API_KEY`, `PUBLIC_URL` and the Stripe variables.

**Any Docker host:**

```bash
docker build -t rankwise app
docker run -p 3000:3000 -v rankwise-data:/data \
  -e APP_SECRET=$(openssl rand -hex 32) -e PUBLIC_URL=https://your-domain \
  -e ANTHROPIC_API_KEY=... rankwise
```

**Stripe setup:**
1. Create a recurring **Price** for Pro and set `STRIPE_PRICE_ID`.
2. Add a webhook endpoint at `https://<your-app>/api/billing/webhook` for `checkout.session.completed` and `customer.subscription.*`, and set `STRIPE_WEBHOOK_SECRET`.
3. Enable the Customer Portal so customers can manage or cancel their plan.

| Variable | Purpose |
|---|---|
| `APP_SECRET` | **Required in production.** Encrypts stored WordPress credentials |
| `PUBLIC_URL` | Public base URL, used in snippet tags and Stripe redirects |
| `ANTHROPIC_API_KEY` | Enables the Claude-powered personas (`CLAUDE_MODEL`, default `claude-opus-5-5`) |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Billing (all three are needed to leave demo mode) |
| `PRO_PRICE_LABEL` | Price shown on the plans page (default `$49/month`) |
| `DATA_DIR` / `DATABASE_FILE` | Where SQLite lives (default `./data/rankwise.db`) |
| `MAX_CRAWL_PAGES` | Pages per audit (default 8) |
| `TRUST_PROXY` | Express trust-proxy hops (default 1) |
| `ALLOW_PRIVATE_HOSTS` | `1` only for local testing; allows crawling localhost/private IPs |

## Security

- **Crawling:** SSRF protection blocks private, loopback and link-local addresses on every redirect hop. Responses are capped at 5 MB and time out.
- **Accounts:** passwords are hashed with scrypt. Sessions use random tokens stored hashed in the database, in an `HttpOnly`, `SameSite=Lax` cookie that is `Secure` in production.
- **Requests:** CSRF is blocked by requiring JSON bodies and a same-origin `Origin` header. Every resource is scoped to its owner, and expensive endpoints are rate-limited.
- **Pages:** responses carry a Content-Security-Policy. Stripe webhooks are signature-verified.
- **WordPress:** Application Passwords are encrypted with AES-256-GCM and never returned to the browser.

## Tests

```bash
npm test
```

- `test/audit.test.js` covers the crawl, audit, fixes and projected uplift against a deliberately broken fixture site.
- `test/api.test.js` covers the full customer journey over HTTP:
  - signup and audit
  - expert review, fix pack and strategist
  - publish → snippet served → customer installs it → verify shows the fixed checks
  - articles and WordPress publishing against a mock WordPress REST API
  - tenant isolation and logout/login
  - CSRF guards
  - Stripe plan gating, signed webhooks and the free-plan limit

## Architecture

```
server.js              Express app and API routes (SSE streaming for audits, chat and articles)
lib/db.js              SQLite schema (node:sqlite) and AES-GCM secret encryption
lib/auth.js            Accounts, sessions, CSRF guard
lib/billing.js         Plans, Stripe Checkout, Portal, webhooks
lib/store.js           Projects, audits, chats, articles, connections, deployments
lib/crawler.js         Crawl and on-page extraction        lib/fetcher.js  Safe fetching (SSRF guard)
lib/audit/             SEO, AEO and GEO checks and scoring  lib/keywords.js Keyword discovery
lib/fixer.js           Fix pack and patched HTML
lib/deploy.js          Live snippet, rendered-page simulation, before/after diff
lib/wordpress.js       WordPress REST publishing
lib/ai.js              Claude personas                     lib/fallback.js Offline rules engine
public/                Single-page front end (hash router)
```

## Limits

- **Root files can't be set by the snippet.** Robots, sitemap and `llms.txt` must live at the domain root, so the customer uploads them.
- **AI crawlers mostly can't see snippet fixes.** Most of them don't run JavaScript, so for full GEO coverage the fixes should eventually move into the site's templates. The Verify step reports raw-HTML scores so this gap stays visible.
- **No search-volume data.** Keywords come from the site's own content; Rankwise has no search volume, ranking or backlink data.
