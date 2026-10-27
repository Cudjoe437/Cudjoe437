const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Markdown rendering with raw HTML escaped and only http(s)/mailto/relative links allowed.
window.marked.use({
  gfm: true,
  renderer: {
    html: ({ text }) => esc(text),
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:|\/|#)/i.test(href || '')) return text;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener nofollow">${text}</a>`;
    },
    image: ({ text }) => esc(text),
  },
});
const md = (text) => window.marked.parse(text || '');

const state = { audit: null, review: null, fixes: null, chat: [], articles: {}, ai: false };

// ---------- SSE over POST
async function streamPost(url, body, on) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    throw new Error(err.error);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) on[event]?.(JSON.parse(data));
    }
  }
}

async function postJson(url, body = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- AI status
fetch('/api/status').then((r) => r.json()).then(({ ai, model }) => {
  state.ai = ai;
  const badge = $('#ai-status');
  badge.textContent = ai ? `AI experts online · ${model}` : 'Offline mode · rules engine';
  badge.classList.toggle('on', ai);
  badge.title = ai ? '' : 'Set ANTHROPIC_API_KEY on the server to enable the Claude-powered expert, strategist and writer.';
});

// ---------- Audit
$('#audit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url').value.trim();
  const btn = $('#audit-btn');
  const progress = $('#progress');
  progress.innerHTML = '';
  $('#audit-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Auditing…';
  const step = (message) => {
    progress.querySelectorAll('li').forEach((li) => li.classList.remove('active'));
    progress.insertAdjacentHTML('beforeend', `<li class="active">${esc(message)}</li>`);
  };
  try {
    await streamPost('/api/audit', { url }, {
      progress: ({ message }) => step(message),
      result: (audit) => showResults(audit),
      error: ({ error }) => { throw new Error(error); },
    });
  } catch (err) {
    $('#audit-error').textContent = err.message;
    $('#audit-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Audit my site';
  }
});

$('#new-audit').addEventListener('click', () => {
  $('#results').hidden = true;
  $('#hero').hidden = false;
  $('#progress').innerHTML = '';
  $('#url').focus();
});

function showResults(audit) {
  Object.assign(state, { audit, review: null, fixes: null, chat: [], articles: {} });
  $('#hero').hidden = true;
  $('#results').hidden = false;
  $('#result-url').textContent = audit.url;
  $('#result-meta').textContent = `${audit.pages.length} page(s) crawled · ${audit.checks.length} checks · ${new Date(audit.crawledAt).toLocaleString()}`;
  renderScores(audit.scores);
  const s = audit.summary;
  $('#stats').innerHTML = `<span class="chip pass">${s.passed} passed</span><span class="chip warn">${s.warnings} warnings</span><span class="chip fail">${s.failed} failed</span><span class="chip info">${s.autoFixable} auto-fixable</span>`;
  renderChecks();
  renderKeywords();
  renderChat();
  renderArticleForm();
  $('#article').hidden = true;
  $('#article-list').innerHTML = '';
  selectTab('expert');
  window.scrollTo({ top: 0 });
  loadReviewThenFixes();
}

function ringColor(v) {
  return v >= 80 ? 'var(--pass)' : v >= 50 ? 'var(--warn)' : 'var(--fail)';
}
function renderScores(scores, target = $('#scores')) {
  const items = [
    ['overall', 'Overall', 'Weighted score'],
    ['seo', 'SEO', 'Search engines'],
    ['aeo', 'AEO', 'Answer engines'],
    ['geo', 'GEO', 'Generative AI'],
  ];
  target.innerHTML = items.map(([k, label, sub]) => `
    <div class="score">
      <div class="ring" style="--v:${scores[k]};--c:${ringColor(scores[k])}">${scores[k]}</div>
      <div class="score-label"><strong>${label}</strong><span>${sub}</span></div>
    </div>`).join('');
}

// ---------- Tabs
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- Expert review
async function loadReviewThenFixes() {
  const id = state.audit.id;
  $('#review').innerHTML = `<p class="loading">${state.ai ? 'The senior expert is analysing your audit (this can take a minute)…' : 'Preparing the expert review…'}</p>`;
  $('#fixes').innerHTML = '<p class="loading">Waiting for the expert’s optimized copy, then generating your fix pack…</p>';
  try {
    const review = await postJson(`/api/audit/${id}/review`);
    if (state.audit?.id !== id) return;
    state.review = review;
    renderReview(review);
  } catch (err) {
    $('#review').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  loadFixes(true);
}

function renderReview(r) {
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...r.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  $('#review').innerHTML = `
    ${r.warning ? `<p class="error">${esc(r.warning)}</p>` : ''}
    <div class="card summary"><h3>Executive summary</h3>${md(r.executiveSummary)}
      ${r.source === 'rules' ? '<p class="muted"><small>Rules-based review. Enable the AI expert for a deeper, written analysis.</small></p>' : ''}</div>
    ${r.quickWins?.length ? `<div class="card"><h3>Quick wins</h3><ul>${r.quickWins.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    <h3 class="section-title">Priority findings</h3>
    <div class="findings">${findings.map((f) => `
      <div class="card finding ${esc(f.severity)}">
        <h4><span class="chip ${f.severity === 'critical' || f.severity === 'high' ? 'fail' : f.severity === 'medium' ? 'warn' : 'info'}">${esc(f.severity)}</span>${esc(f.title)}<span class="tag">${esc(f.pillar)}</span><span class="tag">~${esc(f.effort)}</span></h4>
        <dl><dt>Evidence</dt><dd>${esc(f.evidence)}</dd><dt>Why it matters</dt><dd>${esc(f.whyItMatters)}</dd><dt>Fix</dt><dd>${esc(f.fix)}</dd></dl>
      </div>`).join('')}
    </div>
    ${r.roadmap?.length ? `<h3 class="section-title">Roadmap</h3><div class="roadmap">${r.roadmap.map((p) => `
      <div class="card"><h4>${esc(p.phase)}</h4><span class="muted">${esc(p.timeframe)}</span><ul>${p.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
    ${r.keywordStrategy?.length ? `<h3 class="section-title">Keyword strategy</h3><div class="table-wrap"><table><thead><tr><th>Keyword</th><th>Target page</th><th>Content angle</th></tr></thead><tbody>
      ${r.keywordStrategy.map((k) => `<tr><td class="kw">${esc(k.keyword)}</td><td>${esc(k.targetPage)}</td><td>${esc(k.contentAngle)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="actions" style="margin-top:16px"><button class="btn" data-goto="strategist">Discuss with the strategist →</button><button class="btn btn-primary" data-goto="fixes">See the fixes →</button></div>`;
  $('#review').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.goto)));
}

$('#filter-pillar').addEventListener('change', renderChecks);
$('#filter-status').addEventListener('change', renderChecks);
function renderChecks() {
  const pillar = $('#filter-pillar').value;
  const status = $('#filter-status').value;
  const order = { fail: 0, warn: 1, pass: 2 };
  const checks = state.audit.checks
    .filter((c) => (!pillar || c.pillar === pillar) && (!status || c.status === status))
    .sort((a, b) => order[a.status] - order[b.status] || b.weight - a.weight);
  $('#checks').innerHTML = checks.map((c) => `
    <div class="check">
      <span class="chip ${c.status}">${{ pass: 'Pass', warn: 'Warn', fail: 'Fail' }[c.status]}</span>
      <div>
        <div class="check-title">${esc(c.title)}<span class="tag">${c.pillar}</span>${c.status !== 'pass' && c.fix === 'auto' ? '<span class="tag">auto-fix</span>' : ''}</div>
        <div class="check-detail">${esc(c.detail)}</div>
        ${c.status !== 'pass' ? `<div class="check-rec">→ ${esc(c.recommendation)}</div>` : ''}
      </div>
    </div>`).join('') || '<p class="muted">No checks match these filters.</p>';
}

// ---------- Keywords
function renderKeywords() {
  const kws = state.audit.keywords;
  if (!kws.length) {
    $('#keywords').innerHTML = '<p class="muted">Not enough text on the crawled pages to detect keywords.</p>';
    return;
  }
  const yn = (v) => (v ? '<span class="yes">✓</span>' : '<span class="no">✗</span>');
  $('#keywords').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Keyword</th><th>Relevance</th><th>Intent</th><th>Title</th><th>H1</th><th>Meta</th><th>AEO questions &amp; GEO prompts</th><th></th></tr></thead>
    <tbody>${kws.map((k, i) => `<tr>
      <td class="kw">${esc(k.keyword)}${k.branded ? '<span class="tag">brand</span>' : ''}</td>
      <td>${k.relevance}<div class="bar"><span style="width:${k.relevance}%"></span></div></td>
      <td>${esc(k.intent)}</td><td>${yn(k.inTitle)}</td><td>${yn(k.inH1)}</td><td>${yn(k.inMeta)}</td>
      <td><details><summary>${k.questions.length + k.aiPrompts.length} targets</summary>
        <strong>Questions (AEO)</strong><ul>${k.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
        <strong>AI prompts (GEO)</strong><ul>${k.aiPrompts.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details></td>
      <td><button class="btn btn-sm" data-write="${i}">Write article</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  $('#keywords').querySelectorAll('[data-write]').forEach((b) => b.addEventListener('click', () => {
    const k = kws[Number(b.dataset.write)];
    $('#article-keyword').value = k.keyword;
    fillSecondary();
    selectTab('articles');
    $('#article-form').requestSubmit();
  }));
}

// ---------- Strategist chat
const SUGGESTIONS = [
  'Explain my scores in plain English',
  'What should I fix first?',
  'What is GEO and why does it matter for me?',
  'How do I get into Google’s answer boxes?',
  'How do I apply these fixes on WordPress?',
  'Should I block AI crawlers?',
];
function renderChat() {
  const chat = $('#chat');
  if (!state.chat.length) {
    chat.innerHTML = `<div class="msg assistant">${md(`Hi! I'm your search strategist. I've read your full audit for **${state.audit.url}** — you're at **${state.audit.scores.overall}/100**. Ask me what any result means, what to prioritise, or how to fix something on your platform.`)}</div>`;
  } else {
    chat.innerHTML = state.chat.map((m) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : md(m.content)}</div>`).join('');
  }
  $('#suggestions').innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('#suggestions').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => sendChat(b.textContent)));
  chat.scrollTop = chat.scrollHeight;
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (text) sendChat(text);
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});

let chatBusy = false;
async function sendChat(text) {
  if (chatBusy) return;
  chatBusy = true;
  $('#chat-input').value = '';
  state.chat.push({ role: 'user', content: text });
  renderChat();
  const chat = $('#chat');
  chat.insertAdjacentHTML('beforeend', '<div class="msg assistant"><span class="loading">Thinking</span></div>');
  const bubble = chat.lastElementChild;
  let reply = '';
  try {
    await streamPost(`/api/audit/${state.audit.id}/chat`, { messages: state.chat }, {
      text: ({ text: t }) => { reply += t; bubble.innerHTML = md(reply); chat.scrollTop = chat.scrollHeight; },
      error: ({ error }) => { reply += `\n\n_Error: ${error}_`; bubble.innerHTML = md(reply); },
    });
  } catch (err) {
    reply = `_Error: ${err.message}_`;
  }
  state.chat.push({ role: 'assistant', content: reply || '_No response._' });
  renderChat();
  chatBusy = false;
}

// ---------- Fixes
async function loadFixes(refresh = false) {
  const id = state.audit.id;
  try {
    const pack = await postJson(`/api/audit/${id}/fixes`, { refresh });
    if (state.audit?.id !== id) return;
    state.fixes = pack;
    renderFixes(pack);
  } catch (err) {
    $('#fixes').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

const FILE_INFO = {
  'index.optimized.html': 'Your homepage with every automatic fix applied.',
  'head-tags.html': 'Paste into the <head> of your homepage template.',
  'schema.jsonld': 'Structured data (Organization, WebSite, WebPage, Breadcrumb, FAQ). Wrap in <script type="application/ld+json">.',
  'robots.txt': 'Upload to your domain root. Lets search and AI answer engines crawl you and points to your sitemap.',
  'sitemap.xml': 'Upload to your domain root, then submit in Google Search Console and Bing Webmaster Tools.',
  'llms.txt': 'Upload to your domain root so LLMs get a curated summary of your business (GEO).',
};

function renderFixes(pack) {
  const id = state.audit.id;
  const delta = pack.after.overall - pack.before.overall;
  $('#fixes').innerHTML = `
    <div class="card">
      <h3>Projected score after deploying the fix pack</h3>
      <div class="uplift"><span class="big" style="color:${ringColor(pack.before.overall)}">${pack.before.overall}</span><span class="arrow">→</span>
        <span class="big" style="color:${ringColor(pack.after.overall)}">${pack.after.overall}</span><span class="chip pass">+${delta} points</span></div>
      <div class="scores" id="after-scores"></div>
      <p class="muted">Copy source: ${pack.copy.source === 'ai' ? 'written by the AI expert' : 'derived from your page content (rules engine)'}. We generate the files; you (or your developer) deploy them. We can’t change your live site directly.</p>
      <div class="actions"><a class="btn btn-primary" href="/api/audit/${id}/fixes.zip">Download fix pack (.zip)</a><button class="btn" data-goto="strategist">Ask how to install these</button></div>
    </div>
    <div class="card"><h3>What we fixed (${pack.changes.length})</h3><ul class="changes">${pack.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
    ${pack.remaining.length ? `<div class="card"><h3>Still needs a human (${pack.remaining.length})</h3><ul>${pack.remaining.map((c) => `<li><strong>${esc(c.title)}</strong> <span class="tag">${c.pillar}</span> — ${esc(c.recommendation)}</li>`).join('')}</ul></div>` : ''}
    <h3 class="section-title">Optimized homepage preview</h3>
    <iframe class="preview" sandbox="" title="Optimized homepage preview"></iframe>
    <h3 class="section-title">Generated files</h3>
    ${Object.entries(pack.files).map(([name, content]) => `
      <div class="card file">
        <div class="file-head"><div><code>${esc(name)}</code><div class="muted"><small>${esc(FILE_INFO[name] || '')}</small></div></div>
          <div class="actions"><button class="btn btn-sm" data-copy="${esc(name)}">Copy</button><button class="btn btn-sm" data-download="${esc(name)}">Download</button></div></div>
        <pre><code>${esc(content)}</code></pre>
      </div>`).join('')}`;
  renderScores(pack.after, $('#after-scores'));
  // Preview without scripts; give relative assets a base URL so styles/images load.
  const base = `<base href="${esc(state.audit.url)}">`;
  $('#fixes iframe').srcdoc = pack.files['index.optimized.html'].replace(/<head([^>]*)>/i, `<head$1>${base}`);
  $('#fixes').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.goto)));
  $('#fixes').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(pack.files[b.dataset.copy]);
    b.textContent = 'Copied!';
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  }));
  $('#fixes').querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', () => download(b.dataset.download, pack.files[b.dataset.download])));
}

function download(name, content, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Articles
function renderArticleForm() {
  const kws = state.audit.keywords;
  const ordered = [...kws.filter((k) => !k.branded), ...kws.filter((k) => k.branded)];
  $('#article-keyword').innerHTML = ordered.map((k) => `<option value="${esc(k.keyword)}">${esc(k.keyword)}</option>`).join('') || '<option value="">(enter a keyword)</option>';
  fillSecondary();
}
function fillSecondary() {
  const primary = $('#article-keyword').value;
  $('#article-secondary').value = state.audit.keywords
    .filter((k) => k.keyword !== primary && !k.branded)
    .slice(0, 4)
    .map((k) => k.keyword)
    .join(', ');
}
$('#article-keyword').addEventListener('change', fillSecondary);

let articleBusy = false;
$('#article-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (articleBusy) return;
  const keyword = $('#article-keyword').value;
  if (!keyword) return;
  articleBusy = true;
  const btn = $('#article-btn');
  btn.disabled = true;
  btn.textContent = 'Writing…';
  const out = $('#article');
  out.hidden = false;
  out.innerHTML = `<p class="loading">${state.ai ? 'The content writer is drafting your article…' : 'Building article template…'}</p>`;
  let text = '';
  try {
    await streamPost(`/api/audit/${state.audit.id}/articles`, {
      keyword,
      secondary: $('#article-secondary').value.split(',').map((s) => s.trim()).filter(Boolean),
      angle: $('#article-angle').value,
      tone: $('#article-tone').value,
    }, {
      text: ({ text: t }) => { text += t; out.innerHTML = renderArticle(text); },
      error: ({ error }) => { text += `\n\n_Error: ${error}_`; out.innerHTML = renderArticle(text); },
    });
    state.articles[keyword] = text;
    renderArticleList();
    showArticle(keyword);
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Write article';
    articleBusy = false;
  }
});

function splitFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { meta: m[1], body: text.slice(m[0].length) } : { meta: '', body: text };
}
function renderArticle(text) {
  const { meta, body } = splitFrontMatter(text);
  return `${meta ? `<div class="card"><strong>SEO metadata</strong><pre><code>${esc(meta)}</code></pre></div>` : ''}${md(body)}`;
}
function renderArticleList() {
  $('#article-list').innerHTML = Object.keys(state.articles).map((k) => `<button class="btn btn-sm" data-article="${esc(k)}">📄 ${esc(k)}</button>`).join('');
  $('#article-list').querySelectorAll('[data-article]').forEach((b) => b.addEventListener('click', () => showArticle(b.dataset.article)));
}
function showArticle(keyword) {
  const text = state.articles[keyword];
  const slug = keyword.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const out = $('#article');
  out.hidden = false;
  out.innerHTML = `<div class="actions" style="justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-sm" id="copy-md">Copy Markdown</button>
      <button class="btn btn-sm" id="dl-md">Download .md</button>
      <button class="btn btn-sm" id="dl-html">Download .html</button></div>${renderArticle(text)}`;
  $('#copy-md').addEventListener('click', () => navigator.clipboard.writeText(text));
  $('#dl-md').addEventListener('click', () => download(`${slug}.md`, text, 'text/markdown'));
  $('#dl-html').addEventListener('click', () => {
    const { body } = splitFrontMatter(text);
    download(`${slug}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(keyword)}</title></head><body>${md(body)}</body></html>`, 'text/html');
  });
}
