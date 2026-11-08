import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';

/**
 * Website search, inside PostgreSQL (no extra search server):
 * 1. The words are cleaned and checked against the words the shop actually uses; a typo is fixed to
 *    the closest one ("penicl" -> "pencil", "staedler" -> "staedtler").
 * 2. Synonyms widen each word: "khata" also finds notebooks and exercise books.
 * 3. Products must match every word (or its synonyms), by full word, word start ("staed") or word
 *    form ("notebooks" = "notebook"). If none match all words, those matching some are shown.
 * 4. Best matches first: words in the name count most, then brand and category, then tags and SKUs.
 * The search rows are kept up to date by database triggers (table product_search).
 */

// ---- Words ----

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'to', 'on', 'by']);

/** Lower-case words; letters (any script, Bangla too) and digits only. */
export const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

const isNumber = (w: string) => /^\d+$/.test(w);

/** Edits between two words (a swap of neighbours counts as one: "penicl" -> "pencil" is 1). */
function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

// ---- What the shop knows (cached a short while) ----

interface Knowledge {
  /** Words in product names, brands, categories, tags and SKUs, with how many products use them. */
  vocabulary: Map<string, number>;
  /** "khata" -> its synonym group ["notebook", "khata", ...]; keys are words or phrases. */
  synonyms: Map<string, string[]>;
  /** Longest synonym phrase, in words. */
  longest: number;
  at: number;
}
let known: Promise<Knowledge> | null = null;
let knownAt = 0;
const KNOWLEDGE_TTL = 5 * 60_000;

/** Call after synonyms change, so the next search uses them. */
export function forgetSearchKnowledge() {
  known = null;
}

async function load(): Promise<Knowledge> {
  const [{ rows: words }, { rows: groups }] = await Promise.all([
    db.execute<{ w: string; n: string }>(sql`
      select w, count(distinct ps.product_id) as n
      from product_search ps join products p on p.id = ps.product_id and p.status = 'active',
        regexp_split_to_table(ps.doc, '[^[:alnum:]]+') w
      where length(w) >= 2 group by w`),
    db.execute<{ terms: string[] }>(sql`select terms from search_synonyms`),
  ]);
  const vocabulary = new Map(words.map((r) => [r.w, Number(r.n)]));
  const synonyms = new Map<string, string[]>();
  let longest = 1;
  for (const { terms } of groups) {
    const clean = [...new Set(terms.map((t) => wordsOf(t).join(' ')).filter(Boolean))];
    for (const term of clean) {
      synonyms.set(term, [...new Set([...(synonyms.get(term) ?? []), ...clean])]);
      longest = Math.max(longest, term.split(' ').length);
      // Synonym words are known words: never "corrected" away.
      for (const w of term.split(' ')) if (!vocabulary.has(w)) vocabulary.set(w, 0);
    }
  }
  return { vocabulary, synonyms, longest, at: Date.now() };
}

/** The shop's words. When they are older than 5 minutes, fresh ones load in the background: no search waits. */
function knowledge() {
  if (!known) {
    knownAt = Date.now();
    known = load();
    known.catch(() => (known = null));
  } else if (Date.now() - knownAt > KNOWLEDGE_TTL) {
    knownAt = Date.now();
    const fresh = load();
    fresh.then(
      () => (known = fresh),
      () => (knownAt = 0),
    );
  }
  return known;
}

// ---- Planning a search ----

export interface SearchPlan {
  /** The words as typed, cleaned: "doms penicl". */
  query: string;
  /** The words searched, after spelling fixes: "doms pencil". Same as query when nothing was fixed. */
  searched: string;
  corrected: boolean;
  /** One entry per word or phrase typed; each lists what may match it (the word and its synonyms), as word lists. */
  groups: string[][][];
}

/** The closest known word to a typo, or null when the word is fine (or nothing is close). */
function fix(word: string, vocabulary: Map<string, number>) {
  if (vocabulary.has(word) || isNumber(word) || word.length < 3 || !/^[a-z0-9]+$/.test(word)) return null;
  // The start of a known word ("staed" while typing "staedtler") is fine.
  for (const w of vocabulary.keys()) if (w.startsWith(word)) return null;
  const max = word.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [w, uses] of vocabulary) {
    if (w.length < 3 || isNumber(w)) continue;
    const d = distance(word, w, max);
    if (d > max) continue;
    // Fewer edits first, then the more common word, then a same first letter.
    const score = d * 1000 - Math.min(uses, 999) + (w[0] === word[0] ? 0 : 500);
    if (score < bestScore) [best, bestScore] = [w, score];
  }
  return best;
}

export async function planSearch(raw: string): Promise<SearchPlan | null> {
  const typed = wordsOf(raw).slice(0, 10);
  const meaningful = typed.filter((w) => !STOP.has(w));
  const words = meaningful.length ? meaningful : typed;
  if (!words.length) return null;
  const { vocabulary, synonyms, longest } = await knowledge();

  const fixed = words.map((w) => fix(w, vocabulary) ?? w);
  const groups: string[][][] = [];
  for (let i = 0; i < fixed.length; ) {
    // The longest synonym phrase starting here ("exercise book"), else the single word.
    let size = Math.min(longest, fixed.length - i);
    for (; size > 1; size--) if (synonyms.has(fixed.slice(i, i + size).join(' '))) break;
    const phrase = fixed.slice(i, i + size).join(' ');
    const alternatives = synonyms.get(phrase) ?? [phrase];
    groups.push(alternatives.map((a) => a.split(' ')));
    i += size;
  }
  const query = words.join(' ');
  const searched = fixed.join(' ');
  return { query, searched, corrected: searched !== query, groups };
}

// ---- SQL ----

/** One word as a text-search query: the exact word or its word form; plus word starts for longer words. */
function wordQuery(word: string, prefix: boolean) {
  const starts = prefix && word.length >= 3 && !isNumber(word);
  return starts
    ? sql`(to_tsquery('simple', ${word + ':*'}) || to_tsquery('english', ${word}))`
    : sql`(to_tsquery('simple', ${word}) || to_tsquery('english', ${word}))`;
}

/** The plan as one text-search query. `every`: all typed words must match (else any of them). */
function planQuery(plan: SearchPlan, every: boolean, prefix: boolean) {
  const groups = plan.groups.map((alternatives) =>
    sql.join(
      alternatives.map((words) => sql`(${sql.join(words.map((w) => wordQuery(w, prefix)), sql` && `)})`),
      sql` || `,
    ),
  );
  return sql`(${sql.join(
    groups.map((g) => sql`(${g})`),
    every ? sql` && ` : sql` || `,
  )})`;
}

/** Products ("c" in the card list) matching the plan. */
export const searchWhere = (plan: SearchPlan, every = true): SQL =>
  sql`c.id in (select ps.product_id from product_search ps where ps.tsv @@ ${planQuery(plan, every, true)})`;

/** Best match first: whole words count more than word starts; the whole phrase in the name counts most. */
export const searchRank = (plan: SearchPlan): SQL => sql`(
  select ts_rank_cd(ps.tsv, ${planQuery(plan, false, false)}) * 2 + ts_rank_cd(ps.tsv, ${planQuery(plan, false, true)})
  from product_search ps where ps.product_id = c.id
) + (case when lower(c.name) like ${'%' + plan.searched + '%'} then 1 else 0 end) desc, c.sold desc`;

/** A SKU typed exactly: the product to open straight away. */
export async function productBySku(raw: string) {
  const sku = raw.trim();
  if (!/^[\w-]{3,64}$/.test(sku) || !/\d/.test(sku)) return null;
  const { rows } = await db.execute<{ slug: string }>(sql`
    select p.slug from product_variants v join products p on p.id = v.product_id
    where lower(v.sku) = lower(${sku}) and p.status = 'active' limit 1`);
  return rows[0]?.slug ?? null;
}

/**
 * Does a name (category or brand) match the plan? A typed word or synonym that starts one of its words,
 * or is its plural ("notebooks" matches "Notebook").
 */
export function nameMatches(name: string, plan: SearchPlan) {
  const words = wordsOf(name);
  return plan.groups.some((alternatives) =>
    alternatives.some((phrase) => phrase.every((w) => words.some((nw) => nw.startsWith(w) || w === `${nw}s` || w === `${nw}es`))),
  );
}
