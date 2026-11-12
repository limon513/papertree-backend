/**
 * Website addresses for redirects and the old-site check, written one way:
 * "https://papertree.com.bd/Product/Pen%20Set?x=1#top" -> "/product/pen set/".
 * Lower case, a leading and trailing slash, no ?query or #part. Files keep their ending (/sitemap.xml).
 */
export function cleanPath(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  // A full address: only its path counts.
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  raw = raw.split('#')[0]!.split('?')[0]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Broken %-codes: keep as typed.
  }
  let path = `/${raw}`.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (!/\.[a-z0-9]{2,5}$/.test(path) && !path.endsWith('/')) path += '/';
  if (path.length > 500 || /[\u0000-\u001f]/.test(path)) return null;
  return path;
}

/**
 * Where a redirect may send people: only a path on this website (never another site: that would let
 * anyone use our address to send people to a scam page). A ?query is allowed ("/search/?q=pen").
 */
export function cleanTarget(input: string, ownHosts: string[] = []): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      // A full address only when it is this shop's own website.
      if (!ownHosts.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
      path = u.pathname + u.search;
    } catch {
      return null;
    }
  }
  // "//evil.com" is another site to a browser.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
  const [p, q] = path.split('?');
  const clean = cleanPath(p!);
  if (!clean) return null;
  return q ? `${clean}?${q}`.slice(0, 600) : clean;
}

/** The path part of a target ("/search/?q=pen" -> "/search/"), to compare with redirect sources. */
export const targetPathOf = (target: string) => target.split('?')[0]!;
