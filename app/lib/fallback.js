// Rules-based versions of the three personas, used when no Anthropic API key
// is configured. They work only from audit data, so the app stays useful
// offline; the Claude-powered versions are far richer.
import { deterministicCopy, brandName } from './fixer.js';

const WHY = {
  seo: 'Search engines rely on this signal to crawl, understand and rank the page; fixing it removes friction between your content and Google/Bing.',
  aeo: 'Answer engines (featured snippets, People Also Ask, voice assistants, AI Overviews) extract short, well-structured answers — this determines whether yours gets picked.',
  geo: 'Generative engines like ChatGPT, Claude, Perplexity and Gemini must be able to access, trust and quote your content before they will cite or recommend you.',
};
const EFFORT = { auto: 'minutes', manual: 'hours' };
const severity = (c) => (c.status === 'fail' ? (c.weight >= 4 ? 'critical' : 'high') : c.weight >= 4 ? 'medium' : 'low');

export function ruleReview(record) {
  const { crawl, audit } = record;
  const s = audit.scores;
  const weakest = Object.entries({ SEO: s.seo, AEO: s.aeo, GEO: s.geo }).sort((a, b) => a[1] - b[1])[0];
  const copy = deterministicCopy(crawl, audit);
  return {
    source: 'rules',
    executiveSummary: `${brandName(crawl)} scores ${s.overall}/100 overall (SEO ${s.seo}, AEO ${s.aeo}, GEO ${s.geo}). ${audit.summary.failed} checks failed and ${audit.summary.warnings} need attention; ${audit.summary.autoFixable} of them can be fixed automatically with the generated fix pack. The weakest area is ${weakest[0]} (${weakest[1]}/100), so start there. Top keywords detected: ${audit.keywords.slice(0, 5).map((k) => `"${k.keyword}"`).join(', ')}.`,
    findings: audit.priorities.map((c) => ({
      title: c.title,
      pillar: c.pillar.toUpperCase(),
      severity: severity(c),
      evidence: c.detail,
      whyItMatters: WHY[c.pillar],
      fix: c.recommendation,
      effort: EFFORT[c.fix],
    })),
    quickWins: audit.checks.filter((c) => c.status !== 'pass' && c.fix === 'auto').slice(0, 6).map((c) => `${c.title}: ${c.recommendation}`),
    roadmap: [
      { phase: 'Fix the foundations', timeframe: 'Week 1', actions: audit.checks.filter((c) => c.status === 'fail' && c.pillar === 'seo').map((c) => c.recommendation).slice(0, 5) },
      { phase: 'Win the answer box', timeframe: 'Weeks 2–3', actions: audit.checks.filter((c) => c.status !== 'pass' && c.pillar === 'aeo').map((c) => c.recommendation).slice(0, 5) },
      { phase: 'Become citable by AI', timeframe: 'Weeks 3–6', actions: audit.checks.filter((c) => c.status !== 'pass' && c.pillar === 'geo').map((c) => c.recommendation).slice(0, 5) },
      { phase: 'Scale content', timeframe: 'Ongoing', actions: audit.keywords.slice(0, 4).map((k) => `Publish a pillar article targeting "${k.keyword}" (see Articles tab).`) },
    ].filter((p) => p.actions.length),
    optimizedCopy: copy,
    keywordStrategy: audit.keywords.slice(0, 6).map((k, i) => ({
      keyword: k.keyword,
      targetPage: i === 0 ? crawl.finalUrl : `New page: /${k.keyword.replace(/\s+/g, '-')}`,
      contentAngle: `${k.intent} intent — answer "${k.questions[0]}" up front, then go deep.`,
    })),
  };
}

export function ruleStrategist(record, question) {
  const { audit } = record;
  const q = question.toLowerCase();
  const issues = audit.checks.filter((c) => c.status !== 'pass');
  const match = audit.checks.find((c) => q.includes(c.title.toLowerCase()) || c.id.split(':')[1].split('-').every((w) => q.includes(w)));
  const lines = [];

  if (match) {
    lines.push(`### ${match.title}`, `**Status:** ${match.status.toUpperCase()} — ${match.detail}`, '', `**Why it matters:** ${WHY[match.pillar]}`, '', `**How to fix it:** ${match.recommendation}`, match.fix === 'auto' ? '\nThis one is handled automatically in the **Fixes** tab — download the fix pack and apply the files.' : '');
  } else if (/score|grade|how (am|are|is) (i|we|my)|overall/.test(q)) {
    const s = audit.scores;
    lines.push(`Your overall score is **${s.overall}/100**: SEO **${s.seo}**, AEO **${s.aeo}**, GEO **${s.geo}**.`, '', `- ${audit.summary.passed} checks passed`, `- ${audit.summary.warnings} warnings`, `- ${audit.summary.failed} failures (${audit.summary.autoFixable} auto-fixable)`);
  } else if (/keyword/.test(q)) {
    lines.push('Your top keywords, by on-page prominence:', '', ...audit.keywords.slice(0, 8).map((k) => `- **${k.keyword}** (${k.intent}, relevance ${k.relevance})${k.inTitle ? '' : ' — not in your title yet'}`), '', 'Open the **Articles** tab to generate content around any of them.');
  } else if (/\baeo\b|answer engine|snippet|voice/.test(q)) {
    lines.push('**AEO (Answer Engine Optimization)** is about being the answer that featured snippets, People Also Ask, voice assistants and AI Overviews show. Your open AEO items:', '', ...issues.filter((c) => c.pillar === 'aeo').map((c) => `- **${c.title}** — ${c.recommendation}`));
  } else if (/\bgeo\b|generative|chatgpt|ai search|llm|perplexity|claude|gemini/.test(q)) {
    lines.push('**GEO (Generative Engine Optimization)** is about getting cited and recommended by ChatGPT, Claude, Perplexity and Gemini. Your open GEO items:', '', ...issues.filter((c) => c.pillar === 'geo').map((c) => `- **${c.title}** — ${c.recommendation}`));
  } else if (/\bseo\b/.test(q)) {
    lines.push('Your open SEO items:', '', ...issues.filter((c) => c.pillar === 'seo').map((c) => `- **${c.title}** — ${c.recommendation}`));
  } else {
    lines.push('Here is where I would start — your highest-impact issues:', '', ...audit.priorities.slice(0, 5).map((c, i) => `${i + 1}. **${c.title}** (${c.pillar.toUpperCase()}) — ${c.recommendation}`), '', 'Ask me about any of these by name, or about your score, keywords, AEO or GEO.');
  }
  lines.push('', '_Running in offline mode. Add an `ANTHROPIC_API_KEY` to unlock the full AI strategist._');
  return lines.join('\n');
}

export function templateArticle(record, keyword, secondary) {
  const { crawl } = record;
  const brand = brandName(crawl);
  const K = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  const sec = secondary.length ? secondary : record.audit.keywords.filter((k) => k.keyword !== keyword).slice(0, 4).map((k) => k.keyword);
  const facts = crawl.pages.flatMap((p) => p.paragraphs).filter((p) => p.toLowerCase().includes(keyword)).slice(0, 3);
  const slug = keyword.replace(/[^a-z0-9]+/g, '-');
  return `---
title: "${K}: The Complete Guide"
meta_description: "Everything you need to know about ${keyword} — what it is, how it works, costs, and how to choose the right option. Expert guide from ${brand}."
slug: ${slug}
primary_keyword: ${keyword}
secondary_keywords: [${sec.join(', ')}]
---

> **Template draft** — generated offline from your audit. Add an \`ANTHROPIC_API_KEY\` for a fully written, publication-ready article.

# ${K}: The Complete Guide

**${K}** [one-sentence definition: "${K} is a … that helps … by …"]. In this guide, ${brand} explains what ${keyword} is, how it works, what it costs, and how to choose the right option — so you can make a confident decision.

${facts.length ? facts.map((f) => `> From ${brand}: ${f}`).join('\n\n') : ''}

## What is ${keyword}?

[40–60 word direct answer that defines ${keyword}, who it is for, and the main benefit. This paragraph is your featured-snippet candidate.]

## How does ${keyword} work?

[Concise 40–60 word answer, then detail.]

1. **Step 1:** [first step]
2. **Step 2:** [second step]
3. **Step 3:** [third step]

## What are the benefits of ${keyword}?

${sec.map((s) => `- **${s.replace(/\b\w/g, (c) => c.toUpperCase())}:** [how it relates to ${keyword}]`).join('\n') || '- [Benefit 1]\n- [Benefit 2]\n- [Benefit 3]'}

## How much does ${keyword} cost?

| Option | Typical price | Best for |
|---|---|---|
| Basic | [price] | [audience] |
| Standard | [price] | [audience] |
| Premium | [price] | [audience] |

## How do I choose the right ${keyword}?

[Checklist of 4–6 criteria with a sentence each.]

> **Expert tip:** [A quotable insight from someone at ${brand}, with their name and role.]

## Key takeaways

- ${K} [main point]
- [Second point]
- [Third point]

## Frequently asked questions

${[`What is ${keyword}?`, `How long does ${keyword} take?`, `How much does ${keyword} cost?`, `Is ${keyword} worth it?`, `Why choose ${brand} for ${keyword}?`].map((q) => `### ${q}\n[40–60 word answer]`).join('\n\n')}

## Get started with ${brand}

[Call to action with a link to ${crawl.finalUrl}]
`;
}
