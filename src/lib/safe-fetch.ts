import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Downloads from addresses given by staff (image links in imports, product pages).
 * Only public internet addresses are allowed, so a link can never reach our own server or
 * private network. Redirects are followed by hand and checked the same way.
 */

export class FetchError extends Error {}

function isPrivateIp(ip: string) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

async function checkUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('Not a valid link');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('Only http and https links are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new FetchError(`Cannot find ${url.hostname}`);
  if (addresses.some((a) => isPrivateIp(a.address))) throw new FetchError('This address is not allowed');
  return url;
}

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

/** Fetches a public URL and returns the body, refusing anything bigger than `maxBytes`. */
export async function fetchPublic(
  raw: string,
  { maxBytes, timeoutMs = 20_000, accept = '*/*' }: { maxBytes: number; timeoutMs?: number; accept?: string },
) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const url = await checkUrl(current);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal, headers: { ...BROWSER_HEADERS, accept } });
    } catch (err) {
      throw new FetchError(err instanceof Error && err.name === 'TimeoutError' ? 'The site took too long to answer' : 'Could not reach the site');
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    if (!res.ok) throw new FetchError(`The site answered with error ${res.status}`);

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > maxBytes) throw new FetchError('The file is too big');

    // Read in pieces so a huge answer is stopped early.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FetchError('The file is too big');
      }
      chunks.push(value);
    }
    return { body: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '', url: url.toString() };
  }
  throw new FetchError('Too many redirects');
}
