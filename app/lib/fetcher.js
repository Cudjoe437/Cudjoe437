// Safe HTTP fetching for user-supplied URLs.
// Every hop (including redirects) is checked so a customer URL can't be used
// to reach private network addresses (SSRF protection).
import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT =
  'RankwiseAuditBot/1.0 (+https://github.com/Cudjoe437/Cudjoe437; SEO/AEO/GEO audit)';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const allowPrivate = () => process.env.ALLOW_PRIVATE_HOSTS === '1';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

async function assertPublicHost(hostname) {
  if (allowPrivate()) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch private host "${hostname}"`);
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new Error(`Could not resolve host "${hostname}"`);
      });
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error(`Refusing to fetch private network address for "${hostname}"`);
  }
}

export function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Please enter a website URL.');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported.');
  url.hash = '';
  return url;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a URL, following redirects manually so each hop is validated.
 * Never throws for HTTP error statuses — callers inspect `status`.
 */
export async function safeFetch(input, { timeoutMs = 15000, method = 'GET' } = {}) {
  let url = input instanceof URL ? new URL(input) : normalizeUrl(input);
  const redirects = [];
  const started = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : err.cause?.code || err.message;
      throw new Error(`Could not reach ${url.href} (${reason})`);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      const next = new URL(res.headers.get('location'), url);
      redirects.push({ from: url.href, to: next.href, status: res.status });
      url = next;
      continue;
    }

    const body = method === 'HEAD' ? '' : await readCapped(res).finally(() => clearTimeout(timer));
    clearTimeout(timer);
    return {
      url: url.href,
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      bytes: Buffer.byteLength(body),
      redirects,
      timeMs: Date.now() - started,
    };
  }
  throw new Error(`Too many redirects starting from ${input}`);
}
