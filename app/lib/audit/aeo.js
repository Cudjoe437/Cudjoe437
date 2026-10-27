// Answer Engine Optimization: can featured snippets, People Also Ask,
// voice assistants and AI Overviews lift a direct answer from this site?
import { check } from './check.js';

export function aeoChecks(crawl, keywords) {
  const h = crawl.home;
  const all = crawl.pages.filter((p) => p.headings);
  const out = [];
  const add = (...args) => out.push(check('aeo', ...args));

  const types = new Set(all.flatMap((p) => p.schemaTypes));
  const blocks = all.flatMap((p) => p.answerBlocks);
  const questionHeadings = blocks.length;

  add('question-headings', 'Answer structure', 'Question-style headings', questionHeadings >= 3 ? 'pass' : questionHeadings ? 'warn' : 'fail', 5,
    `${questionHeadings} question-style H2–H4 heading(s) across ${all.length} page(s).`,
    'Phrase key subheadings as the questions customers actually ask ("How much does X cost?").', 'auto');

  const concise = blocks.filter((b) => b.answerWords >= 20 && b.answerWords <= 60).length;
  add('concise-answers', 'Answer structure', 'Snippet-length answers (20–60 words) after questions',
    !blocks.length ? 'fail' : concise / blocks.length >= 0.6 ? 'pass' : 'warn', 5,
    blocks.length ? `${concise} of ${blocks.length} question headings are followed by a 20–60 word answer paragraph.` : 'No question → answer blocks found.',
    'Immediately under each question heading, answer it in one 40–50 word paragraph, then elaborate.', 'auto');

  add('faq-schema', 'Structured answers', 'FAQPage schema', types.has('FAQPage') ? 'pass' : 'fail', 4,
    types.has('FAQPage') ? 'FAQPage markup found.' : 'No FAQPage structured data on crawled pages.',
    'Add an FAQ section with FAQPage JSON-LD that mirrors the visible questions and answers.', 'auto');

  add('howto-schema', 'Structured answers', 'HowTo / step content', types.has('HowTo') || all.some((p) => p.listCount >= 2) ? (types.has('HowTo') ? 'pass' : 'warn') : 'fail', 2,
    types.has('HowTo') ? 'HowTo markup found.' : 'No HowTo schema; ordered/unordered lists are the next best signal.',
    'Present processes as numbered steps and mark up true how-to guides with HowTo schema.', 'manual');

  const lists = h.listCount;
  const tables = h.tableCount;
  add('lists-tables', 'Answer structure', 'Lists & tables for list/table snippets', lists + tables >= 2 ? 'pass' : lists + tables ? 'warn' : 'fail', 3,
    `${lists} list(s) and ${tables} table(s) on the homepage.`,
    'Use bulleted lists for features/steps and comparison tables for pricing/specs — engines extract these directly.', 'manual');

  const definition = all.some((p) => p.paragraphs.some((para) => /^[A-Z][\w\s\-&]{2,60}\s(is|are|refers to|means)\s(a|an|the)\b/.test(para)));
  add('definitions', 'Answer structure', 'Clear definition sentences', definition ? 'pass' : 'warn', 3,
    definition ? 'Found "X is a …" style definitions.' : 'No explicit "X is a …" definition sentences detected.',
    'Open topic pages with a one-sentence definition: "[Topic] is a [category] that [does what]."', 'manual');

  const firstPara = h.paragraphs[0] || '';
  const fpWords = firstPara.split(/\s+/).filter(Boolean).length;
  add('lead-answer', 'Answer structure', 'Direct answer in the opening paragraph', fpWords >= 20 && fpWords <= 80 ? 'pass' : 'warn', 3,
    firstPara ? `Opening paragraph is ${fpWords} words.` : 'No opening paragraph detected.',
    'Lead with a 40–80 word summary that answers the page’s main question (inverted pyramid).', 'manual');

  add('speakable', 'Voice', 'Speakable / voice-ready content', all.some((p) => JSON.stringify(p.jsonLd).includes('speakable')) ? 'pass' : 'warn', 1,
    'Checks for SpeakableSpecification markup used by voice assistants.',
    'Add speakable markup pointing at your summary and FAQ answer selectors.', 'auto');

  add('breadcrumbs', 'Structured answers', 'Breadcrumb markup', types.has('BreadcrumbList') ? 'pass' : 'warn', 2,
    types.has('BreadcrumbList') ? 'BreadcrumbList schema found.' : 'No BreadcrumbList schema.',
    'Add BreadcrumbList JSON-LD so results show a clean path instead of a raw URL.', 'auto');

  const kwQuestions = keywords.slice(0, 5).filter((k) => blocks.some((b) => b.question.toLowerCase().includes(k.keyword)));
  add('keyword-questions', 'Coverage', 'Top keywords answered as questions', kwQuestions.length >= 2 ? 'pass' : kwQuestions.length ? 'warn' : 'fail', 4,
    `${kwQuestions.length} of the top 5 keywords appear in a question heading.`,
    'Create FAQ/Q&A sections for each priority keyword (see the Keywords tab for suggested questions).', 'auto');

  return out;
}
