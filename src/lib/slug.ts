/** "Art & Craft Paper (A4)" -> "art-craft-paper-a4". Only a-z, 0-9 and single dashes. */
export function slugify(text: string) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 100)
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
