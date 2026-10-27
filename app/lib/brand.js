import net from 'node:net';

const GENERIC = /^(home|welcome|homepage|index|untitled|main)$/i;
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Best guess at the business/brand name from the crawled homepage. */
export function brandName(crawl) {
  const h = crawl.home;
  if (h.orgName) return h.orgName;
  if (h.og?.['og:site_name']) return h.og['og:site_name'];
  const parts = (h.title || '').split(/\s[|\-–—:]\s/);
  if (parts.length > 1 && !GENERIC.test(parts.at(-1).trim())) return parts.at(-1).trim();
  const host = new URL(crawl.finalUrl).hostname.replace(/^www\./, '');
  const namedH1 = (h.h1 || []).find((t) => !GENERIC.test(t) && t.split(/\s+/).length <= 4);
  if (net.isIP(host) || host === 'localhost') return namedH1 || (parts[0] && !GENERIC.test(parts[0]) ? parts[0] : 'Our Business');
  return titleCase(host.split('.')[0].replace(/[-_]/g, ' '));
}

/** Does a keyword phrase contain the brand (e.g. "acme widgets" for acme.com)? */
export function isBranded(phrase, crawl) {
  const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const p = squash(phrase);
  const brand = squash(brandName(crawl));
  const hostname = new URL(crawl.finalUrl).hostname.replace(/^www\./, '');
  const host = net.isIP(hostname) ? '' : squash(hostname.split('.')[0]);
  return [brand, host].some((b) => b.length >= 3 && (p.includes(b) || (p.length >= 5 && b.includes(p))));
}
