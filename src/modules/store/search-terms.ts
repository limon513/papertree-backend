import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';

/**
 * Search words shoppers use, for help in the website's search box:
 * - popular searches (shown when the box is opened, before typing);
 * - suggested searches while typing ("pen" -> "pencil", "pencil box").
 *
 * Only searches that found products count, as they were finally searched (a fixed typo counts as the
 * right word: "penicl" -> "pencil"), so nothing odd or rude anyone typed ever shows to others.
 * The list is kept in memory and read again at most every 10 minutes: typing costs no database work.
 */
const DAYS = 30;
const REFRESH_MS = 10 * 60_000;
const MOST = 2000;

type Term = { term: string; count: number };
let terms: Term[] = [];
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Tidy words that read well as a search: letters, digits and a few signs, 2–40 characters. */
const tidy = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const readable = (t: string) => t.length >= 2 && t.length <= 40 && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .&'+/-]*$/u.test(t);

async function load() {
  try {
    const { rows } = await db.execute<{ term: string; n: string }>(sql`
      select lower(regexp_replace(trim(coalesce(corrected_to, query)), '\s+', ' ', 'g')) as term, count(*) as n
      from search_queries
      where results > 0 and created_at > now() - make_interval(days => ${DAYS})
      group by 1
      order by n desc, term
      limit ${MOST}`);
    terms = rows.map((r) => ({ term: tidy(r.term), count: Number(r.n) })).filter((t) => readable(t.term));
  } catch {
    // Keep the list we had; try again next time.
  } finally {
    loadedAt = Date.now();
    loading = null;
  }
}

async function current() {
  const stale = Date.now() - loadedAt > REFRESH_MS;
  // The first time, wait for the list; later, answer with the old one while it is read again.
  if (!loadedAt) await (loading ??= load());
  else if (stale) loading ??= load();
  return terms;
}

/** The most searched words lately (for the box before typing). */
export async function popularSearches(limit = 8) {
  return (await current()).slice(0, limit).map((t) => t.term);
}

/** Searches that start with what is typed, or have a word starting with it; most searched first. */
export async function suggestedSearches(typed: string, limit = 5) {
  const q = tidy(typed);
  if (q.length < 2) return [];
  return (await current())
    .filter((t) => t.term !== q && (t.term.startsWith(q) || t.term.includes(` ${q}`)))
    .sort((a, b) => Number(b.term.startsWith(q)) - Number(a.term.startsWith(q)) || b.count - a.count)
    .slice(0, limit)
    .map((t) => t.term);
}
