import { z } from 'zod';
import { wordsOf } from '../../store/search.ts';

/** A word or short phrase, cleaned the way search reads it: "Exercise-Book" -> "exercise book". */
const term = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((t) => wordsOf(t).join(' '))
  .refine((t) => t.length > 0, { error: 'Use letters or numbers' });

export const synonymBody = z
  .object({
    terms: z
      .array(term)
      .transform((terms) => [...new Set(terms)])
      .refine((terms) => terms.length >= 2, { error: 'Give at least two words that mean the same' })
      .refine((terms) => terms.length <= 30, { error: 'At most 30 words in one group' }),
  })
  .meta({ id: 'SynonymBody', example: { terms: ['notebook', 'khata', 'exercise book'] } });
export type SynonymInput = z.infer<typeof synonymBody>;

export const synonymView = z
  .object({ id: z.number(), terms: z.array(z.string()), updatedAt: z.date() })
  .meta({ id: 'Synonym' });

export const searchReportQuery = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), { error: 'Use 7, 30 or 90' }).default(30),
});

const row = z.object({ query: z.string(), searches: z.number(), lastAt: z.date() });
export const searchReport = z
  .object({
    days: z.number(),
    totals: z.object({ searches: z.number(), noResults: z.number(), corrected: z.number(), different: z.number() }),
    top: z.array(row.extend({ results: z.number() })),
    noResults: z.array(row),
    corrected: z.array(row.extend({ correctedTo: z.string() })),
  })
  .meta({ id: 'SearchReport' });
