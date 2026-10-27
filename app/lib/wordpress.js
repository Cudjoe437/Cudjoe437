// WordPress integration via the core REST API and an Application Password
// (Users → Profile → Application Passwords). No plugin required.
import { marked } from 'marked';
import { safeFetch, normalizeUrl } from './fetcher.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password.replace(/\s+/g, '')}`).toString('base64')}`;
}

async function wpRequest(conn, route, { method = 'GET', body } = {}) {
  const base = conn.siteUrl.replace(/\/+$/, '');
  const url = `${base}/wp-json${route}`;
  const res = await safeFetch(url, {
    method,
    timeoutMs: 20000,
    headers: {
      authorization: authHeader(conn.username, conn.password),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`WordPress REST API not found at ${base}/wp-json (HTTP ${res.status}). Is this a WordPress site with the REST API enabled?`);
  }
  if (!res.ok) {
    const err = new Error(data?.message ? `WordPress: ${data.message.replace(/<[^>]+>/g, '')}` : `WordPress returned HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

/** Validate credentials and capabilities; returns connection metadata. */
export async function verifyConnection({ siteUrl, username, password }) {
  const site = normalizeUrl(siteUrl);
  const conn = { siteUrl: site.origin + site.pathname.replace(/\/+$/, ''), username: String(username || '').trim(), password: String(password || '') };
  if (!conn.username || !conn.password) throw new Error('Enter your WordPress username and an Application Password.');
  let me;
  try {
    me = await wpRequest(conn, '/wp/v2/users/me?context=edit');
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error('WordPress rejected these credentials. Use your username and an Application Password (not your login password).');
    throw err;
  }
  const caps = me.capabilities || {};
  if (!caps.publish_posts && !caps.edit_posts) throw new Error('This WordPress user cannot publish posts. Use an Editor or Administrator account.');
  return {
    conn,
    meta: {
      user: me.name || me.slug,
      roles: me.roles || [],
      canPublishPages: Boolean(caps.publish_pages),
      unfilteredHtml: Boolean(caps.unfiltered_html),
    },
  };
}

function splitArticle(markdown) {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  const front = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (m) front[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  let body = fm ? markdown.slice(fm[0].length) : markdown;
  body = body.replace(/^> \*\*Template draft\*\*.*\n+/m, '');
  // The trailing ```json block holds the article's JSON-LD.
  let jsonLd = null;
  body = body.replace(/```json\s*\n([\s\S]*?)```\s*$/m, (_, code) => {
    try {
      jsonLd = JSON.parse(code);
    } catch {
      return _;
    }
    return '';
  });
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) body = body.replace(h1[0], '');
  return { front, title: front.title || h1?.[1] || 'Untitled', body: body.trim(), jsonLd };
}

const jsonLdHtml = (data) => `\n<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

/** Create or update a post from a generated article. */
export async function publishArticle(conn, meta, markdown, { status = 'draft', postId } = {}) {
  const a = splitArticle(markdown);
  let content = marked.parse(a.body);
  // WordPress strips <script> for users without unfiltered_html, so only add schema when it will survive.
  if (a.jsonLd && meta.unfilteredHtml) content += jsonLdHtml(a.jsonLd);
  const post = {
    title: a.title,
    content,
    status,
    excerpt: a.front.meta_description || '',
    ...(a.front.slug ? { slug: a.front.slug } : {}),
  };
  const seoMeta = a.front.meta_description
    ? { _yoast_wpseo_metadesc: a.front.meta_description, _yoast_wpseo_title: a.title, rank_math_description: a.front.meta_description }
    : null;
  const route = postId ? `/wp/v2/posts/${postId}` : '/wp/v2/posts';
  let result;
  try {
    result = await wpRequest(conn, route, { method: 'POST', body: seoMeta ? { ...post, meta: seoMeta } : post });
  } catch (err) {
    // SEO plugin meta keys are only writable when the plugin registers them; retry without.
    if (!seoMeta || err.status !== 400) throw err;
    result = await wpRequest(conn, route, { method: 'POST', body: post });
  }
  return { id: result.id, url: result.link, status: result.status };
}

/** Create or update an FAQ page with FAQPage schema. */
export async function publishFaqPage(conn, meta, { faqs, brand }, { status = 'publish' } = {}) {
  if (!faqs?.length) throw new Error('There are no FAQs to publish yet.');
  if (!meta.canPublishPages) throw new Error('This WordPress user cannot publish pages.');
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
  };
  const content =
    `<p>Answers to the questions customers ask ${esc(brand)} most often.</p>\n` +
    faqs.map((f) => `<h2>${esc(f.question)}</h2>\n<p>${esc(f.answer)}</p>`).join('\n') +
    (meta.unfilteredHtml ? jsonLdHtml(schema) : '');
  const existing = await wpRequest(conn, '/wp/v2/pages?slug=faq&context=edit&status=publish,draft,private');
  const route = existing[0] ? `/wp/v2/pages/${existing[0].id}` : '/wp/v2/pages';
  const page = await wpRequest(conn, route, { method: 'POST', body: { title: 'Frequently Asked Questions', slug: 'faq', status, content } });
  return { id: page.id, url: page.link, status: page.status };
}
