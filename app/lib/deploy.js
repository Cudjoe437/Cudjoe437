// Live deployment of fixes through a one-line script tag ("Rankwise snippet").
// The customer adds <script src=".../s/KEY.js" async></script> once; whenever
// they publish fixes in Rankwise, the snippet applies them on their pages.
import * as cheerio from 'cheerio';
import { altFromSrc, brandName, patchHtml } from './fixer.js';

const pathOf = (url) => new URL(url).pathname.replace(/\/+$/, '') || '/';

/** Everything the snippet needs to apply a fix pack to the audited page. */
export function buildDeployPayload(crawl, fixPack) {
  const h = crawl.home;
  const copy = fixPack.copy;
  const alts = {};
  h.images.forEach((img, i) => {
    if (img.src && (img.alt === undefined || !img.alt.trim())) alts[img.src] = altFromSrc(img.src, `${brandName(crawl)} image ${i + 1}`);
  });
  return {
    v: 1,
    path: pathOf(crawl.finalUrl),
    lang: h.lang ? null : 'en',
    title: copy.title,
    metaDescription: copy.metaDescription,
    robots: /noindex/.test(h.metaRobots) ? 'index, follow, max-image-preview:large, max-snippet:-1' : null,
    canonical: h.canonical ? null : crawl.finalUrl,
    viewport: h.viewport ? null : 'width=device-width, initial-scale=1',
    meta: {
      'og:type': 'website',
      'og:title': copy.title,
      'og:description': copy.metaDescription,
      'og:url': crawl.finalUrl,
      'og:site_name': brandName(crawl),
      'twitter:card': 'summary_large_image',
    },
    jsonLd: JSON.parse(fixPack.files['schema.jsonld']),
    h1: h.h1.length ? null : copy.h1,
    demoteExtraH1: h.h1.length > 1,
    faqs: h.schemaTypes.includes('FAQPage') ? [] : copy.faqs,
    alts,
    copy,
  };
}

/** Server-side simulation of the snippet, used to audit the page "as Google renders it". */
export function simulateSnippet(crawl, payload) {
  return patchHtml(crawl, payload.copy, payload.jsonLd, { lazy: false }).html;
}

export function snippetPresent(html, key) {
  return cheerio.load(html)('script[src]').toArray().some((el) => String(el.attribs.src).includes(`/s/${key}.js`));
}

/** The browser script served at /s/:key.js. */
export function snippetJs(payload) {
  const data = JSON.stringify(payload ? { ...payload, copy: undefined } : null).replace(/</g, '\\u003c');
  return `/* Rankwise SEO/AEO/GEO fixes — https://github.com/Cudjoe437/Cudjoe437 */
(function () {
  var p = ${data};
  if (!p) return;
  var here = location.pathname.replace(/\\/+$/, '') || '/';
  if (here !== p.path) return;
  function meta(attr, key, value) {
    var el = document.head.querySelector('meta[' + attr + '="' + key + '"]');
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
    el.setAttribute('content', value);
  }
  function apply() {
    try {
      if (p.lang && !document.documentElement.lang) document.documentElement.lang = p.lang;
      if (p.title) document.title = p.title;
      if (p.metaDescription) meta('name', 'description', p.metaDescription);
      if (p.robots) meta('name', 'robots', p.robots);
      if (p.viewport) meta('name', 'viewport', p.viewport);
      Object.keys(p.meta || {}).forEach(function (k) {
        var attr = k.indexOf('og:') === 0 ? 'property' : 'name';
        if (!document.head.querySelector('meta[' + attr + '="' + k + '"]')) meta(attr, k, p.meta[k]);
      });
      if (p.canonical && !document.head.querySelector('link[rel="canonical"]')) {
        var link = document.createElement('link'); link.rel = 'canonical'; link.href = p.canonical; document.head.appendChild(link);
      }
      if (p.jsonLd && !document.getElementById('rankwise-jsonld')) {
        var s = document.createElement('script'); s.type = 'application/ld+json'; s.id = 'rankwise-jsonld';
        s.textContent = JSON.stringify(p.jsonLd); document.head.appendChild(s);
      }
      var h1s = document.querySelectorAll('h1');
      if (p.demoteExtraH1) for (var i = 1; i < h1s.length; i++) {
        var h2 = document.createElement('h2');
        for (var j = 0; j < h1s[i].attributes.length; j++) h2.setAttribute(h1s[i].attributes[j].name, h1s[i].attributes[j].value);
        while (h1s[i].firstChild) h2.appendChild(h1s[i].firstChild);
        h1s[i].parentNode.replaceChild(h2, h1s[i]);
      }
      var main = document.querySelector('main') || document.body;
      if (p.h1 && !h1s.length) { var h = document.createElement('h1'); h.textContent = p.h1; main.insertBefore(h, main.firstChild); }
      document.querySelectorAll('img').forEach(function (img) {
        var alt = p.alts && p.alts[img.getAttribute('src')];
        if (alt && !(img.getAttribute('alt') || '').trim()) img.setAttribute('alt', alt);
      });
      if (p.faqs && p.faqs.length && !document.getElementById('rw-faq-title')) {
        var sec = document.createElement('section'); sec.className = 'rw-faq';
        var t = document.createElement('h2'); t.id = 'rw-faq-title'; t.textContent = 'Frequently asked questions'; sec.appendChild(t);
        p.faqs.forEach(function (f) {
          var q = document.createElement('h3'); q.textContent = f.question; sec.appendChild(q);
          var a = document.createElement('p'); a.textContent = f.answer; sec.appendChild(a);
        });
        main.appendChild(sec);
      }
    } catch (e) { if (window.console) console.warn('Rankwise snippet:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
})();
`;
}

/** Per-check comparison between two audits of the same site. */
export function diffAudits(before, after) {
  const prev = new Map(before.checks.map((c) => [c.id, c]));
  const rank = { fail: 0, warn: 1, pass: 2 };
  const fixed = [];
  const regressed = [];
  const stillOpen = [];
  for (const c of after.checks) {
    const old = prev.get(c.id);
    if (!old) continue;
    if (rank[c.status] > rank[old.status]) fixed.push({ ...c, from: old.status });
    else if (rank[c.status] < rank[old.status]) regressed.push({ ...c, from: old.status });
    else if (c.status !== 'pass') stillOpen.push(c);
  }
  return { fixed, regressed, stillOpen };
}
