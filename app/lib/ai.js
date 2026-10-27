// The three AI personas behind the product, powered by Claude:
//  - Senior SEO/AEO/GEO Expert: technical audit review + optimized copy
//  - Strategist: conversational guide that explains results and explores fixes
//  - Content Writer: long-form articles built around the audited keywords
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export const aiEnabled = () =>
  process.env.AI_DISABLED !== '1' && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const getClient = () => (client ??= new Anthropic());

// Server-side refusal fallback: if a request is declined, the API re-runs it on
// Anthropic's recommended fallback model inside the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const EXPERT_SYSTEM = `You are a senior technical search consultant with 15+ years in SEO and deep, current expertise in AEO (Answer Engine Optimization: featured snippets, People Also Ask, voice assistants, Google AI Overviews) and GEO (Generative Engine Optimization: getting cited by ChatGPT, Claude, Perplexity, Gemini and Copilot).

You receive a crawl snapshot and the results of an automated technical audit for a customer's website. Produce the expert review a top agency would deliver:
- Ground every finding in the evidence provided (cite the specific detail, URL or value). Never invent metrics such as traffic, backlinks, rankings or search volume — you only have what the crawl shows.
- Prioritise by business impact and effort. Explain "why it matters" in plain language a business owner understands.
- Fixes must be concrete and implementable (exact tags, copy, schema types, file contents or steps).
- optimizedCopy must be ready to paste: title 30–60 characters with the primary keyword first and brand last; meta description 140–160 characters with a benefit and call to action; one H1; 4–6 FAQs whose answers are 40–60 words, factually consistent with the site's content (do not promise things the site doesn't state).
- keywordStrategy maps each priority keyword to the page that should rank for it and a content angle.`;

const STRATEGIST_SYSTEM = `You are the customer's dedicated SEO, AEO & GEO strategist inside the Rankwise audit app. The customer has just audited their website; the audit data is below.

How you work:
- Explain results in plain, encouraging language; define jargon the first time (e.g. "schema markup", "canonical", "llms.txt").
- Tie every recommendation to the audit evidence and to the customer's goals. Ask one short clarifying question when their goal, audience or platform (WordPress, Shopify, Webflow, Wix, custom) would change the advice.
- When they want to fix something, give step-by-step instructions for their platform and paste-ready code/copy. Point them to the "Fixes" tab for generated files and the "Articles" tab for keyword content.
- Help them explore trade-offs (e.g. blocking AI training bots vs. being cited by AI search) and sequence work into quick wins vs. longer projects.
- Be honest: you can't see rankings, traffic or backlinks, and no one can guarantee rankings or AI citations.
- Keep answers focused: short paragraphs, bullets for steps, code blocks for code. Use Markdown.`;

const WRITER_SYSTEM = `You are an expert content strategist and writer who creates articles that rank in search (SEO), get lifted into featured snippets and AI Overviews (AEO), and get cited by generative engines like ChatGPT, Claude and Perplexity (GEO).

Every article you write:
- Targets the given primary keyword and naturally weaves in the secondary keywords (no stuffing); primary keyword appears in the H1, the first 100 words, at least one H2 and the conclusion.
- Starts with a YAML front-matter block containing: title (≤60 chars), meta_description (140–160 chars), slug, primary_keyword, secondary_keywords.
- Opens with a 40–60 word direct answer/summary paragraph (the snippet-bait), then a one-sentence definition "X is …".
- Uses question-style H2/H3 headings with a concise 40–60 word answer immediately under each, followed by depth.
- Includes at least one bulleted list, one numbered step list, and one comparison or data table.
- Adds concrete specifics: numbers, examples, steps, criteria. When a statistic is not verifiable from the provided context, phrase it as guidance or mark it "[add source]" — never fabricate studies, quotes, or numbers.
- Includes an "Expert tip" blockquote, a "Key takeaways" list, an FAQ section (5 Q&As), and a closing call to action for the business.
- Writes in a clear, authoritative, helpful voice for the business described; aims for 1,200–1,800 words.
- Ends with a fenced \`json\` block containing FAQPage + Article JSON-LD for the article.
Output only the article in Markdown.`;

const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['executiveSummary', 'findings', 'quickWins', 'roadmap', 'optimizedCopy', 'keywordStrategy'],
  properties: {
    executiveSummary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'pillar', 'severity', 'evidence', 'whyItMatters', 'fix', 'effort'],
        properties: {
          title: { type: 'string' },
          pillar: { type: 'string', enum: ['SEO', 'AEO', 'GEO'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string' },
          whyItMatters: { type: 'string' },
          fix: { type: 'string' },
          effort: { type: 'string', enum: ['minutes', 'hours', 'days', 'weeks'] },
        },
      },
    },
    quickWins: { type: 'array', items: { type: 'string' } },
    roadmap: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'timeframe', 'actions'],
        properties: { phase: { type: 'string' }, timeframe: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } } },
      },
    },
    optimizedCopy: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'metaDescription', 'h1', 'orgDescription', 'faqs'],
      properties: {
        title: { type: 'string' },
        metaDescription: { type: 'string' },
        h1: { type: 'string' },
        orgDescription: { type: 'string' },
        faqs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'answer'],
            properties: { question: { type: 'string' }, answer: { type: 'string' } },
          },
        },
      },
    },
    keywordStrategy: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keyword', 'targetPage', 'contentAngle'],
        properties: { keyword: { type: 'string' }, targetPage: { type: 'string' }, contentAngle: { type: 'string' } },
      },
    },
  },
};

function refusalError(message) {
  const detail = message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '';
  return new Error(`The AI declined this request${detail}`);
}

const contextBlock = (context) => `<audit_data>\n${JSON.stringify(context, null, 1)}\n</audit_data>`;

export async function expertReview(context) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    ...FALLBACK,
    system: [{ type: 'text', text: EXPERT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: reviewSchema } },
    messages: [{ role: 'user', content: `${contextBlock(context)}\n\nWrite the expert technical audit review for ${context.site}.` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw refusalError(message);
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...JSON.parse(text), source: 'ai' };
}

/** Streams the strategist's reply; calls onText for each chunk. */
export async function strategistReply(context, history, onText) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    system: [
      { type: 'text', text: STRATEGIST_SYSTEM },
      { type: 'text', text: contextBlock(context), cache_control: { type: 'ephemeral' } },
    ],
    output_config: { effort: 'low' },
    messages: history,
  });
  stream.on('text', onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw refusalError(message);
}

/** Streams a long-form article; calls onText for each chunk. */
export async function writeArticle({ context, keyword, secondary, angle, tone }, onText) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...FALLBACK,
    system: [{ type: 'text', text: WRITER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium' },
    messages: [
      {
        role: 'user',
        content: `Business context (from the site audit):
${JSON.stringify({ site: context.site, homepage: context.homepage, keywords: context.keywords }, null, 1)}

Write the article.
Primary keyword: ${keyword}
Secondary keywords: ${secondary.join(', ') || '(choose 3–5 closely related terms)'}
${angle ? `Content angle: ${angle}\n` : ''}Tone: ${tone || 'expert, friendly, practical'}`,
      },
    ],
  });
  stream.on('text', onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw refusalError(message);
}
