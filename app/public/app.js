const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Markdown with raw HTML escaped and only safe link schemes.
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

const state = { me: null, audit: null, project: null, review: null, fixes: null, tab: 'expert', pendingUrl: null };

// ---------- API helpers
class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, data.code, res.status);
  return data;
}

async function streamPost(url, body, on) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    throw new ApiError(err.error, err.code, res.status);
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

function download(name, content, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(btn, text) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = old), 1500);
}

const isPro = () => state.me?.usage?.plan === 'pro';

function lockedCard(feature) {
  return `<div class="card locked"><h3>🔒 ${esc(feature)} is a Pro feature</h3>
    <p class="muted">Upgrade to unlock the AI expert, strategist, live fixes, WordPress publishing and keyword articles.</p>
    <a class="btn btn-primary" href="#/billing">See plans</a></div>`;
}
function errorHtml(err) {
  return err?.code === 'upgrade' ? lockedCard('This') : `<p class="error">${esc(err.message)}</p>`;
}

// ---------- Session & nav
async function refreshMe() {
  state.me = await api('GET', '/api/me');
  renderNav();
}

function renderNav() {
  const { user, usage, ai, billing } = state.me;
  $('#topnav').innerHTML = user
    ? `<a href="#/dashboard">Dashboard</a><a href="#/billing">${usage.plan === 'pro' ? '<span class="badge on">Pro</span>' : '<span class="badge">Free</span>'}</a>
       <span class="badge ${ai ? 'on' : ''}" title="${ai ? '' : 'Set ANTHROPIC_API_KEY to enable the Claude-powered personas.'}">${ai ? 'AI online' : 'AI offline'}</span>
       ${billing ? '' : '<span class="badge" title="Stripe is not configured; all features are unlocked.">Demo</span>'}
       <button class="linkish" id="logout">Log out</button>`
    : '<a href="#/login">Log in</a><a class="btn btn-primary btn-sm" href="#/signup">Sign up free</a>';
  $('#logout')?.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout', {});
    await refreshMe();
    location.hash = '#/';
  });
}

// ---------- Router
const routes = [
  [/^#?\/?$/, viewLanding],
  [/^#\/login$/, () => viewAuth('login')],
  [/^#\/signup$/, () => viewAuth('signup')],
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/billing/, viewBilling],
  [/^#\/projects\/([\w-]+)$/, (id) => viewProject(id)],
  [/^#\/audits\/([\w-]+)(?:\/(\w+))?$/, (id, tab) => viewAudit(id, tab)],
];

let lastPage = null;
async function route() {
  if (!state.me) await refreshMe();
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) {
      // Switching tabs within one audit keeps the scroll position.
      const page = hash.replace(/^(#\/audits\/[\w-]+)\/\w+$/, '$1');
      if (page !== lastPage) window.scrollTo({ top: 0 });
      lastPage = page;
      return fn(...m.slice(1));
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

const view = $('#view');
const needLogin = () => {
  if (state.me.user) return false;
  location.hash = '#/signup';
  return true;
};

// ---------- Landing / new audit
function viewLanding() {
  view.innerHTML = $('#tpl-landing').innerHTML;
  const form = $('[data-audit-form]', view);
  if (state.pendingUrl) $('#url').value = state.pendingUrl;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#url').value.trim();
    if (!state.me.user) {
      state.pendingUrl = url;
      location.hash = '#/signup';
      return;
    }
    runAudit(url, view);
  });
  if (state.me.user) {
    loadRecent();
    if (state.pendingUrl) {
      const url = state.pendingUrl;
      state.pendingUrl = null;
      runAudit(url, view);
    }
  }
}

async function loadRecent() {
  const projects = await api('GET', '/api/projects');
  if (!projects.length) return;
  $('[data-recent]', view).innerHTML = `<div class="recent"><h2>Your sites</h2>${projectCards(projects.slice(0, 3))}<a href="#/dashboard">All sites →</a></div>`;
}

async function runAudit(url, root) {
  const btn = $('button[type="submit"]', root);
  const progress = $('[data-progress]', root);
  const errorEl = $('[data-error]', root);
  progress.innerHTML = '';
  errorEl.hidden = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Auditing…';
  const step = (message) => {
    $$('li', progress).forEach((li) => li.classList.remove('active'));
    progress.insertAdjacentHTML('beforeend', `<li class="active">${esc(message)}</li>`);
  };
  try {
    let result;
    await streamPost('/api/audits', { url }, {
      progress: ({ message }) => step(message),
      result: (audit) => (result = audit),
      error: ({ error }) => { throw new Error(error); },
    });
    await refreshMe();
    if (result) location.hash = `#/audits/${result.id}`;
  } catch (err) {
    errorEl.innerHTML = err.code === 'upgrade' ? `${esc(err.message)} <a href="#/billing">Upgrade</a>` : esc(err.message);
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- Auth
function viewAuth(mode) {
  if (state.me.user) { location.hash = state.pendingUrl ? '#/' : '#/dashboard'; return; }
  view.innerHTML = $('#tpl-auth').innerHTML;
  const signup = mode === 'signup';
  $('[data-title]', view).textContent = signup ? 'Create your free account' : 'Welcome back';
  $('[data-sub]', view).textContent = state.pendingUrl ? `Sign ${signup ? 'up' : 'in'} to audit ${state.pendingUrl}.` : signup ? 'Free plan includes 3 audits per month. No card required.' : 'Log in to see your sites and audits.';
  $('[data-submit]', view).textContent = signup ? 'Create account' : 'Log in';
  $('[data-name-field]', view).hidden = !signup;
  $('[data-switch]', view).innerHTML = signup ? 'Already have an account? <a href="#/login">Log in</a>' : 'New to Rankwise? <a href="#/signup">Create an account</a>';
  $('[data-auth-form]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const errEl = $('[data-error]', view);
    errEl.hidden = true;
    try {
      state.me = await api('POST', `/api/auth/${mode}`, data);
      renderNav();
      location.hash = state.pendingUrl ? '#/' : '#/dashboard';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

// ---------- Charts (single series: overall score; hover shows all four)
function scoreColor(v) {
  return v >= 80 ? 'var(--pass)' : v >= 50 ? 'var(--warn)' : 'var(--fail)';
}

function sparkline(history) {
  if (history.length < 2) return '';
  const w = 120, h = 32, pad = 4;
  const pts = history.map((a, i) => [pad + (i * (w - 2 * pad)) / (history.length - 1), h - pad - (a.scores.overall / 100) * (h - 2 * pad)]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Overall score trend: ${history.map((a) => a.scores.overall).join(', ')}">
    <polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="3" fill="var(--accent)"/></svg>`;
}

function historyChart(audits) {
  const data = [...audits].reverse();
  if (data.length < 2) return '<p class="muted">Run another audit (for example after deploying fixes) to see your score trend.</p>';
  const w = 640, h = 220, l = 36, r = 16, t = 14, b = 30;
  const x = (i) => l + (i * (w - l - r)) / (data.length - 1);
  const y = (v) => t + (1 - v / 100) * (h - t - b);
  const grid = [0, 50, 100].map((v) => `<line x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">${v}</text>`).join('');
  const path = data.map((a, i) => `${i ? 'L' : 'M'}${x(i)},${y(a.scores.overall)}`).join(' ');
  const dots = data.map((a, i) => `<circle cx="${x(i)}" cy="${y(a.scores.overall)}" r="4.5" class="dot"/>`).join('');
  const labels = [0, data.length - 1].map((i) => `<text x="${x(i)}" y="${h - 8}" text-anchor="${i ? 'end' : 'start'}" class="axis">${new Date(data[i].created_at).toLocaleDateString()}</text>`).join('');
  const hits = data.map((a, i) => `<rect x="${x(i) - Math.max(10, (w - l - r) / data.length / 2)}" y="${t}" width="${Math.max(20, (w - l - r) / data.length)}" height="${h - t - b}" fill="transparent" data-i="${i}"/>`).join('');
  return `<div class="chart" data-chart>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Overall score over time">${grid}<path d="${path}" class="line"/>${dots}${labels}<line class="crosshair" y1="${t}" y2="${h - b}" hidden/>${hits}</svg>
    <div class="tooltip" hidden></div></div>`;
}

function bindChart(root, audits) {
  const chart = $('[data-chart]', root);
  if (!chart) return;
  const data = [...audits].reverse();
  const tip = $('.tooltip', chart);
  const cross = $('.crosshair', chart);
  const svg = $('svg', chart);
  $$('rect[data-i]', chart).forEach((rect) => {
    rect.addEventListener('mouseenter', () => {
      const a = data[Number(rect.dataset.i)];
      const cx = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.hidden = false;
      tip.innerHTML = `<strong>${fmtDate(a.created_at)}</strong><br>Overall ${a.scores.overall} · SEO ${a.scores.seo} · AEO ${a.scores.aeo} · GEO ${a.scores.geo}`;
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 200, Math.max(0, (cx / 640) * box.width - 100))}px`;
    });
  });
  chart.addEventListener('mouseleave', () => { tip.hidden = true; cross.hidden = true; });
}

// ---------- Dashboard
function projectCards(projects) {
  return `<div class="projects">${projects.map((p) => {
    const last = p.history.at(-1);
    return `<a class="card project" href="#/projects/${p.id}">
      <div class="project-top">
        <div class="ring ring-sm" style="--v:${last?.scores.overall ?? 0};--c:${scoreColor(last?.scores.overall ?? 0)}">${last?.scores.overall ?? '–'}</div>
        <div class="project-name"><strong>${esc(p.name)}</strong><span class="muted">${esc(new URL(p.url).hostname)}</span></div>
      </div>
      ${sparkline(p.history)}
      <span class="muted small">${p.history.length} audit(s)${last ? ` · last ${fmtDate(last.created_at)}` : ''}</span>
    </a>`;
  }).join('')}</div>`;
}

async function viewDashboard() {
  if (needLogin()) return;
  view.innerHTML = '<section class="wrap page"><p class="loading">Loading your sites…</p></section>';
  const projects = await api('GET', '/api/projects');
  const u = state.me.usage;
  view.innerHTML = `<section class="wrap page">
    <div class="page-head"><div><p class="eyebrow">Dashboard</p><h1>Your sites</h1>
      <p class="muted">${u.plan === 'pro' ? 'Pro plan' : 'Free plan'} · ${u.used} of ${u.limit} audits used this month</p></div>
      <a class="btn btn-primary" href="#/">New audit</a></div>
    ${projects.length ? projectCards(projects) : '<div class="card"><h3>No sites yet</h3><p class="muted">Run your first audit to start tracking your SEO, AEO and GEO scores.</p><a class="btn btn-primary" href="#/">Audit a site</a></div>'}
  </section>`;
}

// ---------- Project
async function viewProject(id) {
  if (needLogin()) return;
  view.innerHTML = '<section class="wrap page"><p class="loading">Loading…</p></section>';
  const p = await api('GET', `/api/projects/${id}`);
  view.innerHTML = `<section class="wrap page">
    <div class="page-head"><div><p class="eyebrow">Site</p><h1>${esc(p.name)}</h1><a class="muted" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></div>
      <div class="actions"><button class="btn btn-primary" id="reaudit">Re-audit now</button><button class="btn" id="delete-project">Delete</button></div></div>
    <ol class="progress" data-progress></ol><p class="error" data-error hidden></p>
    <div class="card"><h3>Overall score over time</h3>${historyChart(p.audits)}</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Overall</th><th>SEO</th><th>AEO</th><th>GEO</th><th></th></tr></thead><tbody>
      ${p.audits.map((a) => `<tr><td>${fmtDate(a.created_at)}</td><td><strong>${a.scores.overall}</strong></td><td>${a.scores.seo}</td><td>${a.scores.aeo}</td><td>${a.scores.geo}</td><td><a href="#/audits/${a.id}">Open</a></td></tr>`).join('')}
    </tbody></table></div>
    <div class="grid-2">
      <div class="card"><h3>Live fixes</h3>${p.deployment ? `<p>Published ${fmtDate(p.deployment.publishedAt)}.</p>` : '<p class="muted">No fixes published yet.</p>'}
        <p>Snippet ${p.snippet_last_seen ? `<span class="chip pass">active</span> last seen ${fmtDate(p.snippet_last_seen)}` : '<span class="chip warn">not seen yet</span>'}</p></div>
      <div class="card"><h3>WordPress</h3>${p.connection ? `<p><span class="chip pass">connected</span> ${esc(p.connection.siteUrl)} as ${esc(p.connection.username)}</p>` : '<p class="muted">Not connected.</p>'}
        <p class="muted">${p.articles.length} article(s) written${p.articles.filter((a) => a.wp_url).length ? `, ${p.articles.filter((a) => a.wp_url).length} sent to WordPress` : ''}.</p></div>
    </div>
  </section>`;
  bindChart(view, p.audits);
  $('#reaudit').addEventListener('click', () => runAuditFrom(p.url, view));
  $('#delete-project').addEventListener('click', async () => {
    if (!confirm(`Delete ${p.name} and all its audits, articles and live fixes? The snippet will stop applying fixes.`)) return;
    await api('DELETE', `/api/projects/${p.id}`);
    location.hash = '#/dashboard';
  });
}

function runAuditFrom(url, root) {
  // Reuse runAudit's progress UI on pages whose primary button is not a form submit.
  const btn = $('#reaudit', root) || $('#verify', root);
  btn.type = 'submit';
  return runAudit(url, root);
}

// ---------- Billing
function viewBilling() {
  if (needLogin()) return;
  const { usage, billing, plans } = state.me;
  const status = /status=(\w+)/.exec(location.hash)?.[1];
  view.innerHTML = `<section class="wrap page">
    <div class="page-head"><div><p class="eyebrow">Billing</p><h1>Plans</h1>
      <p class="muted">You're on <strong>${usage.plan === 'pro' ? 'Pro' : 'Free'}</strong> · ${usage.used} of ${usage.limit} audits used this month</p></div></div>
    ${status === 'success' ? '<p class="notice">Thanks! Your Pro subscription is being activated — it can take a few seconds to show here.</p>' : ''}
    ${status === 'cancelled' ? '<p class="notice">Checkout was cancelled. You have not been charged.</p>' : ''}
    ${billing ? '' : '<p class="notice">Demo mode: Stripe is not configured on this server, so every account has Pro features. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to start charging.</p>'}
    <div class="plans">
      ${['free', 'pro'].map((k) => `<div class="card plan ${usage.plan === k ? 'current' : ''}">
        <h2>${plans[k].name}</h2><p class="price">${k === 'free' ? '$0' : esc(usage.price)}</p>
        <ul>${plans[k].features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${usage.plan === k ? '<span class="chip info">Current plan</span>' : ''}
        ${k === 'pro' && billing && usage.plan !== 'pro' ? '<button class="btn btn-primary" id="upgrade">Upgrade to Pro</button>' : ''}
        ${k === 'pro' && billing && usage.plan === 'pro' ? '<button class="btn" id="portal">Manage billing</button>' : ''}
      </div>`).join('')}
    </div>
    <p class="muted small">*Pro includes up to ${plans.pro.auditsPerMonth} audits per month.</p>
    <p class="error" data-error hidden></p>
  </section>`;
  const go = (path) => async (e) => {
    e.target.disabled = true;
    try {
      location.href = (await api('POST', path, {})).url;
    } catch (err) {
      $('[data-error]', view).textContent = err.message;
      $('[data-error]', view).hidden = false;
      e.target.disabled = false;
    }
  };
  $('#upgrade')?.addEventListener('click', go('/api/billing/checkout'));
  $('#portal')?.addEventListener('click', go('/api/billing/portal'));
  if (status === 'success') setTimeout(async () => { await refreshMe(); if (location.hash.startsWith('#/billing')) viewBilling(); }, 3000);
}

// ---------- Audit results
const TABS = [
  ['expert', 'Expert audit'],
  ['keywords', 'Keywords'],
  ['strategist', 'Strategist'],
  ['fixes', 'Fixes'],
  ['golive', 'Go live'],
  ['articles', 'Articles'],
];

function renderScores(scores, target) {
  const items = [['overall', 'Overall', 'Weighted score'], ['seo', 'SEO', 'Search engines'], ['aeo', 'AEO', 'Answer engines'], ['geo', 'GEO', 'Generative AI']];
  target.innerHTML = items.map(([k, label, sub]) => `
    <div class="score"><div class="ring" style="--v:${scores[k]};--c:${scoreColor(scores[k])}">${scores[k]}</div>
      <div class="score-label"><strong>${label}</strong><span>${sub}</span></div></div>`).join('');
}

async function viewAudit(id, tab) {
  if (needLogin()) return;
  if (state.audit?.id !== id) {
    view.innerHTML = '<section class="wrap page"><p class="loading">Loading audit…</p></section>';
    const audit = await api('GET', `/api/audits/${id}`);
    Object.assign(state, { audit, review: null, fixes: null, project: null });
    renderAuditShell();
    loadReviewThenFixes();
  } else if (!$('#results')) {
    renderAuditShell();
    if (state.review) renderReview(state.review);
  }
  selectTab(tab || 'expert');
}

function renderAuditShell() {
  const a = state.audit;
  const c = a.comparison;
  view.innerHTML = `<section class="wrap page" id="results">
    <div class="page-head"><div><p class="eyebrow"><a href="#/projects/${a.projectId}">← Site history</a></p>
      <h1 class="url">${esc(a.url)}</h1><p class="muted">${a.pages.length} page(s) crawled · ${a.checks.length} checks · ${fmtDate(a.crawledAt)}</p></div>
      <a class="btn" href="#/">New audit</a></div>
    ${c ? `<div class="card compare">
      <h3>Since your last audit (${fmtDate(c.previousAt)})</h3>
      <div class="uplift"><span class="big" style="color:${scoreColor(c.before.overall)}">${c.before.overall}</span><span class="arrow">→</span>
        <span class="big" style="color:${scoreColor(c.after.overall)}">${c.after.overall}</span>
        <span class="chip ${c.after.overall >= c.before.overall ? 'pass' : 'fail'}">${c.after.overall >= c.before.overall ? '+' : ''}${c.after.overall - c.before.overall} points</span></div>
      <div class="grid-3">
        <div><strong class="pass-text">✓ Fixed (${c.fixed.length})</strong><ul>${c.fixed.slice(0, 12).map((x) => `<li>${esc(x.title)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
        <div><strong class="fail-text">✗ Regressed (${c.regressed.length})</strong><ul>${c.regressed.map((x) => `<li>${esc(x.title)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>
        <div><strong>Still open (${c.stillOpen.length})</strong><ul>${c.stillOpen.slice(0, 6).map((x) => `<li>${esc(x.title)}</li>`).join('')}${c.stillOpen.length > 6 ? `<li class="muted">+${c.stillOpen.length - 6} more</li>` : ''}</ul></div>
      </div></div>` : ''}
    <div class="scores" id="scores"></div>
    ${a.rendered ? `<p class="notice">The Rankwise snippet is live on this page. Scores above show the page <strong>as Google renders it</strong> (with fixes applied). In raw HTML, which most AI crawlers read, it scores <strong>${a.scores.overall}</strong> overall. Upload robots.txt, sitemap.xml and llms.txt, and move fixes into your templates over time to close that gap.</p>` : ''}
    <div class="stats" id="stats"></div>
    <nav class="tabs" role="tablist">${TABS.map(([k, label]) => `<a role="tab" href="#/audits/${a.id}/${k}" data-tab="${k}">${label}</a>`).join('')}</nav>
    <section class="panel" data-panel="expert">
      <div class="persona"><div class="avatar" aria-hidden="true">SE</div><div><strong>Senior SEO, AEO &amp; GEO Expert</strong><p class="muted">Technical review of every check, prioritised by business impact.</p></div></div>
      <div id="review"></div>
      <h3 class="section-title">All checks</h3>
      <div class="filters"><select id="filter-pillar" aria-label="Filter by pillar"><option value="">All pillars</option><option value="seo">SEO</option><option value="aeo">AEO</option><option value="geo">GEO</option></select>
        <select id="filter-status" aria-label="Filter by status"><option value="">All statuses</option><option value="fail">Failed</option><option value="warn">Warnings</option><option value="pass">Passed</option></select></div>
      <div id="checks" class="checks"></div>
    </section>
    <section class="panel" data-panel="keywords" hidden>
      <p class="muted">Top keywords found on your site, ranked by how prominently and consistently you use them. Questions are AEO targets; AI prompts are what people ask ChatGPT and other assistants (GEO).</p>
      <div id="keywords"></div>
    </section>
    <section class="panel" data-panel="strategist" hidden>
      <div class="persona"><div class="avatar avatar-alt" aria-hidden="true">ST</div><div><strong>Your Search Strategist</strong><p class="muted">Ask anything about your results, what to fix first, or how to do it on your platform. Conversations are saved.</p></div></div>
      <div id="strategist"></div>
    </section>
    <section class="panel" data-panel="fixes" hidden><div id="fixes"></div></section>
    <section class="panel" data-panel="golive" hidden><div id="golive"></div></section>
    <section class="panel" data-panel="articles" hidden><div id="articles"></div></section>
  </section>`;
  const scores = a.rendered?.scores || a.scores;
  renderScores(scores, $('#scores'));
  const s = a.rendered?.summary || a.summary;
  $('#stats').innerHTML = `<span class="chip pass">${s.passed} passed</span><span class="chip warn">${s.warnings} warnings</span><span class="chip fail">${s.failed} failed</span><span class="chip info">${s.autoFixable} auto-fixable</span>`;
  $('#filter-pillar').addEventListener('change', renderChecks);
  $('#filter-status').addEventListener('change', renderChecks);
  renderChecks();
  renderKeywords();
}

const loaded = new Set();
function selectTab(name) {
  state.tab = name;
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  const key = `${state.audit.id}:${name}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  if (name === 'strategist') renderStrategist();
  if (name === 'golive') renderGoLive();
  if (name === 'articles') renderArticles();
  if (name === 'fixes' && !state.fixes) $('#fixes').innerHTML = isPro() ? '<p class="loading">Generating your fix pack…</p>' : lockedCard('The fix pack');
}

// ---------- Expert review
async function loadReviewThenFixes() {
  const id = state.audit.id;
  $('#review').innerHTML = `<p class="loading">${state.me.ai && isPro() ? 'The senior expert is analysing your audit (this can take a minute)…' : 'Preparing the expert review…'}</p>`;
  try {
    const review = await api('POST', `/api/audits/${id}/review`, {});
    if (state.audit?.id !== id) return;
    state.review = review;
    renderReview(review);
  } catch (err) {
    $('#review').innerHTML = errorHtml(err);
  }
  if (isPro()) loadFixes();
}

function renderReview(r) {
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...r.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  $('#review').innerHTML = `
    ${r.warning ? `<p class="error">${esc(r.warning)}</p>` : ''}
    <div class="card summary"><h3>Executive summary</h3>${md(r.executiveSummary)}
      ${r.locked ? '<p class="muted small">Rules-based review. <a href="#/billing">Upgrade to Pro</a> for the AI expert’s written analysis.</p>' : r.source === 'rules' ? '<p class="muted small">Rules-based review (AI is offline on this server).</p>' : ''}</div>
    ${r.quickWins?.length ? `<div class="card"><h3>Quick wins</h3><ul>${r.quickWins.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    <h3 class="section-title">Priority findings</h3>
    <div class="findings">${findings.map((f) => `
      <div class="card finding ${esc(f.severity)}">
        <h4><span class="chip ${f.severity === 'critical' || f.severity === 'high' ? 'fail' : f.severity === 'medium' ? 'warn' : 'info'}">${esc(f.severity)}</span>${esc(f.title)}<span class="tag">${esc(f.pillar)}</span><span class="tag">~${esc(f.effort)}</span></h4>
        <dl><dt>Evidence</dt><dd>${esc(f.evidence)}</dd><dt>Why it matters</dt><dd>${esc(f.whyItMatters)}</dd><dt>Fix</dt><dd>${esc(f.fix)}</dd></dl>
      </div>`).join('')}</div>
    ${r.roadmap?.length ? `<h3 class="section-title">Roadmap</h3><div class="roadmap">${r.roadmap.map((p) => `
      <div class="card"><h4>${esc(p.phase)}</h4><span class="muted">${esc(p.timeframe)}</span><ul>${p.actions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
    ${r.keywordStrategy?.length ? `<h3 class="section-title">Keyword strategy</h3><div class="table-wrap"><table><thead><tr><th>Keyword</th><th>Target page</th><th>Content angle</th></tr></thead><tbody>
      ${r.keywordStrategy.map((k) => `<tr><td class="kw">${esc(k.keyword)}</td><td>${esc(k.targetPage)}</td><td>${esc(k.contentAngle)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="actions" style="margin-top:16px"><a class="btn" href="#/audits/${state.audit.id}/strategist">Discuss with the strategist →</a><a class="btn btn-primary" href="#/audits/${state.audit.id}/golive">Put the fixes live →</a></div>`;
}

function renderChecks() {
  const pillar = $('#filter-pillar').value;
  const status = $('#filter-status').value;
  const order = { fail: 0, warn: 1, pass: 2 };
  const checks = state.audit.checks
    .filter((c) => (!pillar || c.pillar === pillar) && (!status || c.status === status))
    .sort((a, b) => order[a.status] - order[b.status] || b.weight - a.weight);
  $('#checks').innerHTML = checks.map((c) => `
    <div class="check"><span class="chip ${c.status}">${{ pass: 'Pass', warn: 'Warn', fail: 'Fail' }[c.status]}</span>
      <div><div class="check-title">${esc(c.title)}<span class="tag">${c.pillar}</span>${c.status !== 'pass' && c.fix === 'auto' ? '<span class="tag">auto-fix</span>' : ''}</div>
        <div class="check-detail">${esc(c.detail)}</div>${c.status !== 'pass' ? `<div class="check-rec">→ ${esc(c.recommendation)}</div>` : ''}</div>
    </div>`).join('') || '<p class="muted">No checks match these filters.</p>';
}

// ---------- Keywords
function renderKeywords() {
  const kws = state.audit.keywords;
  if (!kws.length) { $('#keywords').innerHTML = '<p class="muted">Not enough text on the crawled pages to detect keywords.</p>'; return; }
  const yn = (v) => (v ? '<span class="yes" aria-label="yes">✓</span>' : '<span class="no" aria-label="no">✗</span>');
  $('#keywords').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Keyword</th><th>Relevance</th><th>Intent</th><th>Title</th><th>H1</th><th>Meta</th><th>AEO questions &amp; GEO prompts</th><th></th></tr></thead>
    <tbody>${kws.map((k, i) => `<tr>
      <td class="kw">${esc(k.keyword)}${k.branded ? '<span class="tag">brand</span>' : ''}</td>
      <td>${k.relevance}<div class="bar"><span style="width:${k.relevance}%"></span></div></td>
      <td>${esc(k.intent)}</td><td>${yn(k.inTitle)}</td><td>${yn(k.inH1)}</td><td>${yn(k.inMeta)}</td>
      <td><details><summary>${k.questions.length + k.aiPrompts.length} targets</summary>
        <strong>Questions (AEO)</strong><ul>${k.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
        <strong>AI prompts (GEO)</strong><ul>${k.aiPrompts.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details></td>
      <td><button class="btn btn-sm" data-write="${i}">Write article</button></td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-write]', $('#keywords')).forEach((b) => b.addEventListener('click', () => {
    state.prefillKeyword = kws[Number(b.dataset.write)].keyword;
    location.hash = `#/audits/${state.audit.id}/articles`;
    if (loaded.has(`${state.audit.id}:articles`)) renderArticles();
  }));
}

// ---------- Strategist
const SUGGESTIONS = ['Explain my scores in plain English', 'What should I fix first?', 'What is GEO and why does it matter for me?', 'How do I get into Google’s answer boxes?', 'How do I install the Rankwise snippet on my platform?', 'Should I block AI crawlers?'];

async function renderStrategist() {
  const root = $('#strategist');
  if (!isPro()) { root.innerHTML = lockedCard('The AI strategist'); return; }
  root.innerHTML = `<div id="chat" class="chat" aria-live="polite"></div><div class="suggestions" id="suggestions"></div>
    <form id="chat-form" class="chat-form"><label class="sr-only" for="chat-input">Message the strategist</label>
      <textarea id="chat-input" rows="2" placeholder="e.g. What should I fix first? I'm on WordPress."></textarea><button class="btn btn-primary" type="submit">Send</button></form>`;
  const history = await api('GET', `/api/audits/${state.audit.id}/chat`);
  const chat = $('#chat');
  const paint = () => {
    chat.innerHTML = history.length
      ? history.map((m) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : md(m.content)}</div>`).join('')
      : `<div class="msg assistant">${md(`Hi! I'm your search strategist. I've read your full audit for **${state.audit.url}** — you're at **${(state.audit.rendered || state.audit).scores.overall}/100**. Ask me what any result means, what to prioritise, or how to fix something on your platform.`)}</div>`;
    chat.scrollTop = chat.scrollHeight;
  };
  paint();
  $('#suggestions').innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  let busy = false;
  const send = async (text) => {
    if (busy || !text) return;
    busy = true;
    $('#chat-input').value = '';
    history.push({ role: 'user', content: text });
    paint();
    chat.insertAdjacentHTML('beforeend', '<div class="msg assistant"><span class="loading">Thinking</span></div>');
    const bubble = chat.lastElementChild;
    let reply = '';
    try {
      await streamPost(`/api/audits/${state.audit.id}/chat`, { message: text }, {
        text: ({ text: t }) => { reply += t; bubble.innerHTML = md(reply); chat.scrollTop = chat.scrollHeight; },
        error: ({ error }) => { reply += `\n\n_Error: ${error}_`; bubble.innerHTML = md(reply); },
      });
    } catch (err) {
      reply = `_Error: ${err.message}_`;
    }
    history.push({ role: 'assistant', content: reply || '_No response._' });
    paint();
    busy = false;
  };
  $$('#suggestions button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); send($('#chat-input').value.trim()); });
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
}

// ---------- Fixes
const FILE_INFO = {
  'index.optimized.html': 'Your homepage with every automatic fix applied.',
  'head-tags.html': 'Paste into the <head> of your homepage template (or let the snippet do it).',
  'schema.jsonld': 'Structured data (Organization, WebSite, WebPage, Breadcrumb, FAQ).',
  'robots.txt': 'Upload to your domain root. Lets search and AI answer engines crawl you and points to your sitemap.',
  'sitemap.xml': 'Upload to your domain root, then submit in Google Search Console and Bing Webmaster Tools.',
  'llms.txt': 'Upload to your domain root so LLMs get a curated summary of your business (GEO).',
};

async function loadFixes() {
  const id = state.audit.id;
  try {
    const pack = await api('POST', `/api/audits/${id}/fixes`, {});
    if (state.audit?.id !== id) return;
    state.fixes = pack;
    renderFixes(pack);
    if (loaded.has(`${id}:golive`)) renderGoLive();
  } catch (err) {
    $('#fixes').innerHTML = errorHtml(err);
  }
}

function renderFixes(pack) {
  const id = state.audit.id;
  const delta = pack.after.overall - pack.before.overall;
  $('#fixes').innerHTML = `
    <div class="card"><h3>Projected score after deploying the fix pack</h3>
      <div class="uplift"><span class="big" style="color:${scoreColor(pack.before.overall)}">${pack.before.overall}</span><span class="arrow">→</span>
        <span class="big" style="color:${scoreColor(pack.after.overall)}">${pack.after.overall}</span><span class="chip pass">+${delta} points</span></div>
      <div class="scores" id="after-scores"></div>
      <p class="muted">Copy ${pack.copy.source === 'ai' ? 'written by the AI expert' : 'derived from your page content'}.</p>
      <div class="actions"><a class="btn btn-primary" href="#/audits/${id}/golive">Put these fixes live →</a><a class="btn" href="/api/audits/${id}/fixes.zip">Download fix pack (.zip)</a></div></div>
    <div class="card"><h3>What we fixed (${pack.changes.length})</h3><ul class="changes">${pack.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
    ${pack.remaining.length ? `<div class="card"><h3>Still needs a human (${pack.remaining.length})</h3><ul>${pack.remaining.map((c) => `<li><strong>${esc(c.title)}</strong> <span class="tag">${c.pillar}</span> — ${esc(c.recommendation)}</li>`).join('')}</ul></div>` : ''}
    <h3 class="section-title">Optimized homepage preview</h3>
    <iframe class="preview" sandbox="" title="Optimized homepage preview"></iframe>
    <h3 class="section-title">Generated files</h3>
    ${Object.entries(pack.files).map(([name, content]) => `
      <div class="card file"><div class="file-head"><div><code>${esc(name)}</code><div class="muted small">${esc(FILE_INFO[name] || '')}</div></div>
        <div class="actions"><button class="btn btn-sm" data-copy="${esc(name)}">Copy</button><button class="btn btn-sm" data-download="${esc(name)}">Download</button></div></div>
        <pre><code>${esc(content)}</code></pre></div>`).join('')}`;
  renderScores(pack.after, $('#after-scores'));
  $('#fixes iframe').srcdoc = pack.files['index.optimized.html'].replace(/<head([^>]*)>/i, `<head$1><base href="${esc(state.audit.url)}">`);
  $$('[data-copy]', $('#fixes')).forEach((b) => b.addEventListener('click', () => copyText(b, pack.files[b.dataset.copy])));
  $$('[data-download]', $('#fixes')).forEach((b) => b.addEventListener('click', () => download(b.dataset.download, pack.files[b.dataset.download])));
}

// ---------- Go live
const PLATFORMS = {
  WordPress: 'Install the free <strong>WPCode</strong> (Insert Headers and Footers) plugin → Code Snippets → Header &amp; Footer → paste into <em>Header</em> → Save.',
  Shopify: 'Online Store → Themes → ⋯ → Edit code → <code>layout/theme.liquid</code> → paste just before <code>&lt;/head&gt;</code> → Save.',
  Webflow: 'Site settings → Custom code → <em>Head code</em> → paste → Save → Publish.',
  Wix: 'Settings → Advanced → Custom code → Add code → paste → place in <em>Head</em> on <em>All pages</em> → Apply.',
  Squarespace: 'Settings → Advanced → Code injection → <em>Header</em> → paste → Save.',
  'Custom / HTML': 'Paste the tag inside <code>&lt;head&gt;</code> of your site template (or every page’s HTML).',
};

async function renderGoLive() {
  const root = $('#golive');
  if (!isPro()) { root.innerHTML = lockedCard('Live deployment'); return; }
  root.innerHTML = '<p class="loading">Loading…</p>';
  const p = await api('GET', `/api/projects/${state.audit.projectId}`);
  state.project = p;
  const a = state.audit;
  const tag = `<script src="${p.snippetUrl}" async></script>`;
  const publishedThis = p.deployment?.auditId === a.id;
  const pack = state.fixes;
  root.innerHTML = `
    <div class="status-row">
      <div class="card status"><span class="muted small">Fixes</span><strong>${p.deployment ? `Published ${fmtDate(p.deployment.publishedAt)}` : 'Not published'}</strong></div>
      <div class="card status"><span class="muted small">Snippet</span><strong>${a.snippet.installed ? '✓ Installed on your page' : p.snippet_last_seen ? `Seen ${fmtDate(p.snippet_last_seen)}` : 'Not detected yet'}</strong></div>
      <div class="card status"><span class="muted small">WordPress</span><strong>${p.connection ? '✓ Connected' : 'Not connected'}</strong></div>
    </div>

    <div class="card step"><h3><span class="num">1</span> Publish your fixes</h3>
      <p>Rankwise will serve the corrected title, meta description, canonical, social tags, structured data (Organization, WebSite, FAQ…), image alt text and an FAQ section to your homepage.</p>
      ${pack ? `<ul class="changes">${pack.changes.filter((c) => !/lazy-loaded/i.test(c)).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="loading">Preparing fixes…</p>'}
      <div class="actions"><button class="btn btn-primary" id="publish" ${pack ? '' : 'disabled'}>${publishedThis ? 'Republish fixes' : 'Publish fixes'}</button>
        ${p.deployment ? '<button class="btn" id="unpublish">Unpublish</button>' : ''}</div>
      <p class="small muted" id="publish-status">${publishedThis ? '✓ These fixes are live for every visitor once the snippet is installed.' : p.deployment ? 'Fixes from an earlier audit are live. Publish to update them.' : ''}</p></div>

    <div class="card step"><h3><span class="num">2</span> Install the snippet (one time)</h3>
      <p>Add this line to your site’s <code>&lt;head&gt;</code>. Future publishes update automatically — no more code changes.</p>
      <div class="codebox"><pre><code>${esc(tag)}</code></pre><button class="btn btn-sm" id="copy-tag">Copy</button></div>
      <div class="platforms">${Object.entries(PLATFORMS).map(([name, how]) => `<details><summary>${esc(name)}</summary><p>${how}</p></details>`).join('')}</div>
      <p class="small muted">Google renders JavaScript and will see these fixes. Most AI crawlers read raw HTML only, so for full GEO coverage also move the fixes into your templates over time (use <a href="#/audits/${a.id}/fixes">the fix pack</a>).</p></div>

    <div class="card step"><h3><span class="num">3</span> Upload root files</h3>
      <p>These must live at your domain root, so they can’t be applied by a script:</p>
      <div class="actions">${['robots.txt', 'sitemap.xml', 'llms.txt'].map((f) => `<button class="btn btn-sm" data-root="${f}" ${pack ? '' : 'disabled'}>Download ${f}</button>`).join('')}</div>
      <p class="small muted">Current status: robots.txt ${a.infra.robots ? '✓' : '✗'} · sitemap.xml ${a.infra.sitemap.found ? '✓' : '✗'} · llms.txt ${a.infra.llmsTxt ? '✓' : '✗'}</p></div>

    <div class="card step"><h3><span class="num">4</span> WordPress auto-publishing <span class="tag">optional</span></h3>
      ${p.connection ? `
        <p><span class="chip pass">connected</span> ${esc(p.connection.siteUrl)} as <strong>${esc(p.connection.username)}</strong>
          ${p.connection.meta.unfilteredHtml ? '' : '<br><span class="small muted">This user can’t add raw HTML, so structured data is left out of posts — the snippet still adds site-wide schema.</span>'}</p>
        <div class="actions"><button class="btn" id="wp-faq" ${pack?.copy.faqs.length ? '' : 'disabled'}>Publish FAQ page</button><a class="btn" href="#/audits/${a.id}/articles">Publish articles →</a><button class="btn" id="wp-disconnect">Disconnect</button></div>
        <p class="small" id="wp-status">${p.connection.meta.faqPage ? `FAQ page: <a href="${esc(p.connection.meta.faqPage.url)}" target="_blank" rel="noopener">${esc(p.connection.meta.faqPage.url)}</a>` : ''}</p>`
      : `
        <p>Connect WordPress to publish your FAQ page and articles directly. Create an <strong>Application Password</strong> in WordPress under <em>Users → Profile → Application Passwords</em>.</p>
        <form id="wp-form" class="inline-form">
          <label>Site URL<input name="siteUrl" type="text" value="${esc(p.origin)}" required></label>
          <label>Username<input name="username" type="text" required autocomplete="off"></label>
          <label>Application Password<input name="password" type="password" required autocomplete="off"></label>
          <button class="btn btn-primary" type="submit">Connect</button>
        </form><p class="small muted">Credentials are verified with WordPress and stored encrypted. You can disconnect any time.</p>`}
      <p class="error" id="wp-error" hidden></p></div>

    <div class="card step"><h3><span class="num">5</span> Verify on your live site</h3>
      <p>Once the snippet is installed (and root files uploaded), re-audit to confirm exactly which checks are now fixed.</p>
      <div class="actions"><button class="btn btn-primary" id="verify">Verify live site</button></div>
      <ol class="progress" data-progress></ol><p class="error" data-error hidden></p></div>`;

  $('#copy-tag').addEventListener('click', (e) => copyText(e.target, tag));
  $$('[data-root]', root).forEach((b) => b.addEventListener('click', () => download(b.dataset.root, state.fixes.files[b.dataset.root])));
  $('#publish')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('POST', `/api/audits/${a.id}/deploy`, {});
      renderGoLive();
    } catch (err) {
      $('#publish-status').innerHTML = errorHtml(err);
      e.target.disabled = false;
    }
  });
  $('#unpublish')?.addEventListener('click', async () => {
    if (!confirm('Stop applying Rankwise fixes on your site?')) return;
    await api('DELETE', `/api/projects/${p.id}/deploy`);
    renderGoLive();
  });
  const wpError = (err) => { $('#wp-error').textContent = err.message; $('#wp-error').hidden = false; };
  $('#wp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await api('POST', `/api/projects/${p.id}/wordpress`, Object.fromEntries(new FormData(e.target)));
      renderGoLive();
    } catch (err) {
      wpError(err);
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
  $('#wp-faq')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const page = await api('POST', `/api/audits/${a.id}/wordpress/faq`, {});
      $('#wp-status').innerHTML = `✓ FAQ page ${esc(page.status === 'publish' ? 'published' : 'saved')}: <a href="${esc(page.url)}" target="_blank" rel="noopener">${esc(page.url)}</a>`;
    } catch (err) {
      wpError(err);
    }
    e.target.disabled = false;
  });
  $('#wp-disconnect')?.addEventListener('click', async () => {
    await api('DELETE', `/api/projects/${p.id}/wordpress`);
    renderGoLive();
  });
  $('#verify').addEventListener('click', () => {
    loaded.clear();
    runAuditFrom(a.url, $('#verify').closest('.step'));
  });
}

// ---------- Articles
async function renderArticles() {
  const root = $('#articles');
  if (!isPro()) { root.innerHTML = lockedCard('AI keyword articles'); return; }
  const p = state.project?.id === state.audit.projectId ? state.project : await api('GET', `/api/projects/${state.audit.projectId}`);
  state.project = p;
  const kws = state.audit.keywords;
  const ordered = [...kws.filter((k) => !k.branded), ...kws.filter((k) => k.branded)];
  root.innerHTML = `
    <form id="article-form" class="article-form">
      <label>Primary keyword<input id="article-keyword" list="kw-list" required><datalist id="kw-list">${ordered.map((k) => `<option value="${esc(k.keyword)}">`).join('')}</datalist></label>
      <label>Secondary keywords <span class="muted">(comma separated)</span><input id="article-secondary" type="text"></label>
      <label>Angle <span class="muted">(optional)</span><input id="article-angle" type="text" placeholder="e.g. A buyer's guide for first-time customers"></label>
      <label>Tone<select id="article-tone"><option>expert, friendly, practical</option><option>authoritative and data-driven</option><option>warm and conversational</option><option>concise and technical</option></select></label>
      <button class="btn btn-primary" type="submit" id="article-btn">Write article</button>
    </form>
    <h3 class="section-title">Your articles (${p.articles.length})</h3>
    <div id="article-list" class="article-rows">${p.articles.map((x) => articleRow(x, p)).join('') || '<p class="muted">No articles yet — pick a keyword above.</p>'}</div>
    <article id="article" class="article md" hidden></article>`;
  const fill = () => {
    const primary = $('#article-keyword').value;
    $('#article-secondary').value = kws.filter((k) => k.keyword !== primary && !k.branded).slice(0, 4).map((k) => k.keyword).join(', ');
  };
  $('#article-keyword').value = state.prefillKeyword || ordered[0]?.keyword || '';
  fill();
  $('#article-keyword').addEventListener('change', fill);
  bindArticleRows(p);
  $('#article-form').addEventListener('submit', (e) => { e.preventDefault(); writeArticle(); });
  if (state.prefillKeyword) {
    state.prefillKeyword = null;
    writeArticle();
  }
}

function articleRow(x, p) {
  return `<div class="card article-row" data-id="${x.id}">
    <div><strong>${esc(x.keyword)}</strong><div class="muted small">${fmtDate(x.created_at)}${x.wp_url ? ` · WordPress ${esc(x.wp_status)}: <a href="${esc(x.wp_url)}" target="_blank" rel="noopener">view</a>` : ''}</div></div>
    <div class="actions"><button class="btn btn-sm" data-act="view">View</button><button class="btn btn-sm" data-act="md">.md</button><button class="btn btn-sm" data-act="html">.html</button>
      ${p.connection ? `<button class="btn btn-sm" data-act="wp-draft">${x.wp_post_id ? 'Update WP draft' : 'Send to WP as draft'}</button><button class="btn btn-sm btn-primary" data-act="wp-publish">Publish on WP</button>` : ''}</div>
  </div>`;
}

function splitFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { meta: m[1], body: text.slice(m[0].length) } : { meta: '', body: text };
}
const renderArticle = (text) => {
  const { meta, body } = splitFrontMatter(text);
  return `${meta ? `<div class="card"><strong>SEO metadata</strong><pre><code>${esc(meta)}</code></pre></div>` : ''}${md(body)}`;
};

function bindArticleRows(p) {
  $$('.article-row', $('#articles')).forEach((row) => {
    const x = p.articles.find((a) => a.id === row.dataset.id);
    const slug = x.keyword.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    $$('[data-act]', row).forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'view') { $('#article').hidden = false; $('#article').innerHTML = renderArticle(x.markdown); $('#article').scrollIntoView({ behavior: 'smooth' }); }
      if (act === 'md') download(`${slug}.md`, x.markdown, 'text/markdown');
      if (act === 'html') download(`${slug}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(x.keyword)}</title></head><body>${md(splitFrontMatter(x.markdown).body)}</body></html>`, 'text/html');
      if (act.startsWith('wp-')) {
        b.disabled = true;
        b.textContent = 'Sending…';
        try {
          await api('POST', `/api/articles/${x.id}/wordpress`, { status: act === 'wp-publish' ? 'publish' : 'draft' });
          state.project = null;
          renderArticles();
        } catch (err) {
          alert(err.message);
          b.disabled = false;
        }
      }
    }));
  });
}

let articleBusy = false;
async function writeArticle() {
  if (articleBusy) return;
  const keyword = $('#article-keyword').value.trim();
  if (!keyword) return;
  articleBusy = true;
  const btn = $('#article-btn');
  btn.disabled = true;
  btn.textContent = 'Writing…';
  const out = $('#article');
  out.hidden = false;
  out.innerHTML = `<p class="loading">${state.me.ai ? 'The content writer is drafting your article…' : 'Building article template…'}</p>`;
  out.scrollIntoView({ behavior: 'smooth' });
  let text = '';
  try {
    await streamPost(`/api/audits/${state.audit.id}/articles`, {
      keyword,
      secondary: $('#article-secondary').value.split(',').map((s) => s.trim()).filter(Boolean),
      angle: $('#article-angle').value,
      tone: $('#article-tone').value,
    }, {
      text: ({ text: t }) => { text += t; out.innerHTML = renderArticle(text); },
      error: ({ error }) => { text += `\n\n_Error: ${error}_`; out.innerHTML = renderArticle(text); },
    });
    state.project = null;
    articleBusy = false;
    await renderArticles();
    $('#article').hidden = false;
    $('#article').innerHTML = renderArticle(text);
  } catch (err) {
    out.innerHTML = errorHtml(err);
  } finally {
    articleBusy = false;
    if ($('#article-btn')) { $('#article-btn').disabled = false; $('#article-btn').textContent = 'Write article'; }
  }
}

route();
