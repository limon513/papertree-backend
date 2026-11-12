/**
 * "Art & Craft Paper (A4)" -> "art-craft-paper-a4". Only a-z, 0-9 and single dashes. Made from a name: at
 * most 100 characters; a URL name typed or copied from the old site keeps up to 200 (WordPress's limit).
 */
export function slugify(text: string, max = 100) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

/** The first of "base", "base-2", "base-3", ... that is not taken. */
export function freeSlug(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
