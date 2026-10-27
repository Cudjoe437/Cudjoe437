// Generative Engine Optimization: will ChatGPT, Claude, Perplexity, Gemini
// and Google AI Overviews be able to crawl, understand, trust and cite this site?
import { check } from './check.js';
import { robotsBlocksAgent } from '../crawler.js';

export const AI_CRAWLERS = [
  { agent: 'GPTBot', owner: 'OpenAI (training)' },
  { agent: 'OAI-SearchBot', owner: 'ChatGPT search' },
  { agent: 'ChatGPT-User', owner: 'ChatGPT browsing' },
  { agent: 'ClaudeBot', owner: 'Anthropic (training)' },
  { agent: 'Claude-SearchBot', owner: 'Claude search' },
  { agent: 'Claude-User', owner: 'Claude browsing' },
  { agent: 'PerplexityBot', owner: 'Perplexity' },
  { agent: 'Google-Extended', owner: 'Gemini / Vertex AI' },
  { agent: 'Applebot-Extended', owner: 'Apple Intelligence' },
  { agent: 'CCBot', owner: 'Common Crawl (used by many LLMs)' },
];

export function geoChecks(crawl) {
  const h = crawl.home;
  const all = crawl.pages.filter((p) => p.headings);
  const out = [];
  const add = (...args) => out.push(check('geo', ...args));

  const blockedBots = AI_CRAWLERS.filter((b) => robotsBlocksAgent(crawl.robots.parsed, b.agent));
  const searchBots = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot'];
  const blockedSearch = blockedBots.filter((b) => searchBots.includes(b.agent));
  add('ai-crawlers', 'AI access', 'AI crawlers allowed in robots.txt', blockedSearch.length ? 'fail' : blockedBots.length ? 'warn' : 'pass', 5,
    blockedBots.length ? `Blocked: ${blockedBots.map((b) => `${b.agent} (${b.owner})`).join(', ')}` : `None of ${AI_CRAWLERS.length} major AI crawlers are blocked.`,
    'Allow AI search/answer bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot…) so assistants can cite you. Blocking training-only bots is a business choice.', 'auto');

  add('llms-txt', 'AI access', 'llms.txt file', crawl.llmsTxt.found ? 'pass' : 'fail', 4,
    crawl.llmsTxt.found ? 'llms.txt found.' : 'No /llms.txt — LLMs get no curated map of your key content.',
    'Publish /llms.txt: a markdown summary of who you are plus links to your most important pages.', 'auto');

  add('server-rendered', 'AI access', 'Content is server-rendered', h.spaShell ? 'fail' : h.wordCount >= 150 ? 'pass' : 'warn', 5,
    h.spaShell ? 'Page looks like a JavaScript app shell — most AI crawlers do not execute JS and will see an empty page.' : `${h.wordCount} words available in raw HTML.`,
    'Server-side render or pre-render content; AI crawlers mostly read raw HTML only.', 'manual');

  const types = new Set(all.flatMap((p) => p.schemaTypes));
  const hasOrg = [...types].some((t) => /Organization|LocalBusiness|Corporation/.test(t));
  add('entity-schema', 'Entity & trust', 'Organization entity markup', hasOrg ? 'pass' : 'fail', 4,
    hasOrg ? `Organization schema found${h.orgName ? ` (“${h.orgName}”)` : ''}.` : 'No Organization/LocalBusiness schema — engines can’t confidently identify the brand entity.',
    'Add Organization JSON-LD with name, logo, url, description, contactPoint and sameAs profiles.', 'auto');

  const sameAs = all.flatMap((p) => p.orgSameAs);
  add('same-as', 'Entity & trust', 'sameAs links to authoritative profiles', sameAs.length >= 3 ? 'pass' : sameAs.length ? 'warn' : 'fail', 3,
    sameAs.length ? `${sameAs.length} sameAs link(s).` : 'No sameAs links connecting your brand to LinkedIn, Wikipedia, Crunchbase, social profiles, etc.',
    'List your official profiles in Organization.sameAs so LLMs can reconcile your entity across the web.', 'auto');

  const authored = all.filter((p) => p.author).length;
  add('authorship', 'Entity & trust', 'Author / expertise signals (E-E-A-T)', authored ? 'pass' : 'warn', 3,
    authored ? `${authored} page(s) declare an author.` : 'No author bylines or author schema detected.',
    'Add named authors with credentials, Person schema and an About page to show real expertise.', 'auto');

  const dated = all.filter((p) => p.datePublished || p.dateModified).length;
  add('freshness', 'Content quality', 'Freshness signals (published/updated dates)', dated ? 'pass' : 'warn', 3,
    dated ? `${dated} page(s) expose a publish/modified date.` : 'No visible or structured dates — generative engines favour fresh, dated content.',
    'Show "Last updated" dates and add datePublished/dateModified to Article schema.', 'auto');

  const stats = all.reduce((s, p) => s + p.statCount, 0);
  add('statistics', 'Content quality', 'Statistics & concrete data', stats >= 5 ? 'pass' : stats ? 'warn' : 'fail', 4,
    `${stats} statistic(s)/numeric claims detected across crawled pages.`,
    'Add specific numbers, original data and benchmarks — GEO research shows statistics markedly raise citation rates.', 'manual');

  const cites = all.reduce((s, p) => s + p.citationLinks, 0);
  add('citations', 'Content quality', 'Citations to authoritative sources', cites >= 3 ? 'pass' : cites ? 'warn' : 'fail', 3,
    `${cites} outbound link(s) to .gov/.edu/.org/research sources.`,
    'Back claims with links to authoritative sources; cited content is cited more by LLMs.', 'manual');

  const quotes = all.reduce((s, p) => s + p.blockquoteCount, 0);
  add('quotations', 'Content quality', 'Expert quotes', quotes ? 'pass' : 'warn', 2,
    quotes ? `${quotes} blockquote(s) found.` : 'No quotations from experts or customers.',
    'Include attributed quotes from experts/customers — quotable lines get lifted into AI answers.', 'manual');

  const avgWords = Math.round(all.reduce((s, p) => s + p.wordCount, 0) / Math.max(1, all.length));
  add('depth', 'Content quality', 'Comprehensive topical coverage', avgWords >= 800 ? 'pass' : avgWords >= 400 ? 'warn' : 'fail', 3,
    `Average ${avgWords} words per crawled page.`,
    'Build pillar pages and topic clusters that cover each subject end-to-end.', 'manual');

  const brandInTitle = h.orgName && h.title.toLowerCase().includes(h.orgName.toLowerCase());
  add('brand-clarity', 'Entity & trust', 'Clear brand & offering statement', (h.metaDescription && h.h1.length && (brandInTitle || h.title)) ? 'pass' : 'warn', 3,
    'Checks that the title, H1 and description clearly state who you are and what you offer.',
    'State plainly in the first lines: who you are, what you do, for whom, and where.', 'auto');

  return out;
}
