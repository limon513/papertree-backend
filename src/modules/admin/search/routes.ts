import { Router } from 'express';
import { asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { searchSynonyms } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { forgetSearchKnowledge } from '../../store/search.ts';
import { searchReportQuery, synonymBody, type SynonymInput } from './schemas.ts';

// ---- Synonyms (Products section) ----

/** Mounted behind requireAdmin + requireModule('products'). */
export const synonymsRouter = Router();

const view = (r: typeof searchSynonyms.$inferSelect) => ({ id: r.id, terms: r.terms, updatedAt: r.updatedAt });

/** A word may be in one group only, so a search never mixes two meanings by accident. */
async function checkTaken(input: SynonymInput, exceptId?: number) {
  const others = await db
    .select()
    .from(searchSynonyms)
    .where(exceptId === undefined ? undefined : ne(searchSynonyms.id, exceptId));
  for (const group of others) {
    const taken = input.terms.find((t) => group.terms.includes(t));
    if (taken) throw conflict(`“${taken}” is already in the group “${group.terms.slice(0, 3).join(', ')}”. Add the other words to that group instead.`);
  }
}

synonymsRouter.get('/', async (_req, res) => {
  const rows = await db.select().from(searchSynonyms).orderBy(asc(sql`${searchSynonyms.terms}[1]`));
  res.json(rows.map(view));
});

synonymsRouter.post('/', async (req, res) => {
  const input = synonymBody.parse(req.body);
  await checkTaken(input);
  const [row] = await db.insert(searchSynonyms).values(input).returning();
  forgetSearchKnowledge();
  await audit(req, { action: 'search.synonym.create', entityType: 'search_synonym', entityId: row!.id, after: input });
  res.status(201).json(view(row!));
});

synonymsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = synonymBody.parse(req.body);
  const [before] = await db.select().from(searchSynonyms).where(eq(searchSynonyms.id, id));
  if (!before) throw notFound('Synonym group not found');
  await checkTaken(input, id);
  const [row] = await db.update(searchSynonyms).set(input).where(eq(searchSynonyms.id, id)).returning();
  forgetSearchKnowledge();
  await audit(req, { action: 'search.synonym.update', entityType: 'search_synonym', entityId: id, before: { terms: before.terms }, after: input });
  res.json(view(row!));
});

synonymsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db.delete(searchSynonyms).where(eq(searchSynonyms.id, id)).returning();
  if (!row) throw notFound('Synonym group not found');
  forgetSearchKnowledge();
  await audit(req, { action: 'search.synonym.delete', entityType: 'search_synonym', entityId: id, before: { terms: row.terms } });
  res.status(204).end();
});

// ---- Search report (Reports section) ----

/** Mounted behind requireAdmin + requireModule('reports'). */
export const searchReportRouter = Router();

searchReportRouter.get('/', async (req, res) => {
  const { days } = searchReportQuery.parse(req.query);
  const since = sql`now() - make_interval(days => ${days})`;
  type Row = { query: string; searches: string; last_at: Date; results?: string; corrected_to?: string };
  const [{ rows: totals }, { rows: top }, { rows: none }, { rows: fixed }] = await Promise.all([
    db.execute<{ searches: string; no_results: string; corrected: string; different: string }>(sql`
      select count(*) as searches, count(*) filter (where results = 0) as no_results,
        count(*) filter (where corrected_to is not null) as corrected, count(distinct lower(query)) as different
      from search_queries where created_at >= ${since}`),
    // The words as most often typed, how many found the last time.
    db.execute<Row>(sql`
      select mode() within group (order by query) as query, count(*) as searches, max(created_at) as last_at,
        (array_agg(results order by created_at desc))[1] as results
      from search_queries where created_at >= ${since}
      group by lower(query) order by count(*) desc, max(created_at) desc limit 50`),
    db.execute<Row>(sql`
      select mode() within group (order by query) as query, count(*) as searches, max(created_at) as last_at
      from search_queries where created_at >= ${since} and results = 0
      group by lower(query) order by count(*) desc, max(created_at) desc limit 50`),
    db.execute<Row>(sql`
      select mode() within group (order by query) as query, count(*) as searches, max(created_at) as last_at,
        mode() within group (order by corrected_to) as corrected_to
      from search_queries where created_at >= ${since} and corrected_to is not null
      group by lower(query) order by count(*) desc, max(created_at) desc limit 50`),
  ]);
  const t = totals[0]!;
  const rowView = (r: Row) => ({ query: r.query, searches: Number(r.searches), lastAt: new Date(r.last_at) });
  res.json({
    days,
    totals: { searches: Number(t.searches), noResults: Number(t.no_results), corrected: Number(t.corrected), different: Number(t.different) },
    top: top.map((r) => ({ ...rowView(r), results: Number(r.results) })),
    noResults: none.map(rowView),
    corrected: fixed.map((r) => ({ ...rowView(r), correctedTo: r.corrected_to! })),
  });
});
