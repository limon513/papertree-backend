import { Router } from 'express';
import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errors, json } from '../../docs/common.ts';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { unauthorized } from '../../lib/errors.ts';
import { similarTo } from '../photo-search/service.ts';
import { currentCustomer } from './account/session.ts';
import { activeCategories, cards, inCategories, SORTS } from './catalog.ts';

/**
 * The home page for a signed-in customer: a few rows of their own, built from what the shop already
 * knows (products they looked at, their orders, their wishlist). The home page itself stays the same
 * cached page for everyone; the website asks for these rows afterwards and adds them.
 * - recent: products looked at in the last 30 days and not bought since, newest first.
 * - buyAgain: products from their orders, most often bought first (in stock only).
 * - forYou: 12 picks: products that look like what they viewed lately, and popular ones from the
 *   categories they like (views, wishlist, orders), never what they bought or just looked at.
 * Each row is a list of product ids; the website draws the usual cards for them.
 */
export const personalRouter = Router();

const ROW = 12;
const FOR_YOU = 12;
const ids = (list: number[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);

/** Of these products, the ones a shopper can see now (active, not custom), optionally only in stock, in the same order. */
async function showable(list: number[], inStockOnly: boolean) {
  if (!list.length) return [];
  const { items } = await cards(sql`c.id in (${ids(list)})${inStockOnly ? sql` and c.in_stock` : sql``}`, sql`c.id`, list.length);
  const ok = new Set(items.map((i) => i.id));
  return list.filter((id) => ok.has(id));
}

export async function personalHome(customerId: number) {
  const [{ rows: viewed }, { rows: bought }, { rows: liked }] = await Promise.all([
    db.execute<{ product_id: string }>(sql`
      select product_id from customer_activity
      where customer_id = ${customerId} and kind = 'product' and product_id is not null and created_at > now() - interval '30 days'
      group by product_id order by max(created_at) desc limit 40`),
    db.execute<{ product_id: string; last_at: Date }>(sql`
      select oi.product_id, max(o.created_at) as last_at from order_items oi join orders o on o.id = oi.order_id
      where o.customer_id = ${customerId} and o.status not in ('cancelled', 'returned') and oi.product_id is not null
      group by oi.product_id order by count(distinct o.id) desc, max(o.created_at) desc limit 40`),
    db.execute<{ product_id: string }>(sql`select product_id from wishlist_items where customer_id = ${customerId}`),
  ]);
  const boughtIds = bought.map((r) => Number(r.product_id));
  const boughtAt = new Map(bought.map((r) => [Number(r.product_id), new Date(r.last_at).getTime()]));
  // Looked at, and not bought since (an order before the look does not count against it).
  const { rows: lastViews } = viewed.length
    ? await db.execute<{ product_id: string; at: Date }>(sql`
        select product_id, max(created_at) as at from customer_activity
        where customer_id = ${customerId} and kind = 'product' and product_id in (${ids(viewed.map((v) => Number(v.product_id)))}) group by product_id`)
    : { rows: [] };
  const viewedAt = new Map(lastViews.map((r) => [Number(r.product_id), new Date(r.at).getTime()]));
  const viewedIds = viewed.map((r) => Number(r.product_id)).filter((id) => (boughtAt.get(id) ?? 0) < (viewedAt.get(id) ?? 0));

  const [recent, buyAgain] = await Promise.all([showable(viewedIds, false).then((l) => l.slice(0, ROW)), showable(boughtIds, true).then((l) => l.slice(0, ROW))]);

  // ---- Picks ----
  const skip = new Set([...boughtIds, ...recent]);
  const picks: number[] = [];
  const add = (id: number) => {
    if (!skip.has(id) && !picks.includes(id)) picks.push(id);
  };
  // Looks like what they viewed lately (the 3 latest): the best 3 of each, in stock.
  const lookAlikes = await Promise.all(viewedIds.slice(0, 3).map((id) => similarTo(id, 12).catch(() => ({ items: [] }))));
  const alike = lookAlikes.map((r) => r.items.filter((i) => i.inStock).map((i) => i.id));

  // The categories they like: wishlist and orders count more than a look.
  const weights = new Map<number, number>();
  const likedIds = liked.map((r) => Number(r.product_id));
  const signals = [...viewedIds.map((id) => [id, 1] as const), ...likedIds.map((id) => [id, 2] as const), ...boughtIds.map((id) => [id, 3] as const)];
  if (signals.length) {
    const { rows: primary } = await db.execute<{ product_id: string; category_id: string }>(sql`
      select distinct on (product_id) product_id, category_id from product_categories
      where product_id in (${ids([...new Set(signals.map(([id]) => id))])}) order by product_id, is_primary desc, category_id`);
    const categoryOf = new Map(primary.map((r) => [Number(r.product_id), Number(r.category_id)]));
    for (const [id, w] of signals) {
      const c = categoryOf.get(id);
      if (c) weights.set(c, (weights.get(c) ?? 0) + w);
    }
  }
  const cats = await activeCategories();
  const favourite = [...weights.entries()].filter(([id]) => cats.byId.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
  const fromCategories = await Promise.all(
    favourite.map((id) => cards(sql`${inCategories([id, ...cats.descendants(id)])} and c.in_stock`, SORTS.popular, 12).then((r) => r.items.map((i) => i.id))),
  );
  // Take turns: a look-alike, then one from each liked category, round and round.
  for (let round = 0; picks.length < FOR_YOU && round < 12; round++) {
    for (const list of [...alike, ...fromCategories]) {
      const next = list.find((id) => !skip.has(id) && !picks.includes(id));
      if (next) add(next);
      if (picks.length >= FOR_YOU) break;
    }
  }
  // Something to go on but not enough: topped up with popular products, so the row is always full.
  if (picks.length && picks.length < FOR_YOU) {
    const { items } = await cards(sql`c.in_stock`, SORTS.popular, FOR_YOU * 3);
    for (const i of items) if (picks.length < FOR_YOU) add(i.id);
  }
  return { recent, buyAgain, forYou: picks.length >= FOR_YOU ? picks : [] };
}

/** The signed-in customer's own home page rows (product ids). 401 for guests. */
personalRouter.get('/me/home', async (req, res) => {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized();
  res.set('cache-control', 'private, no-store').json(await personalHome(c.id));
});

/** For the API reference (/docs). */
export const personalDocs: ZodOpenApiPathsObject = {
  '/v1/store/me/home': {
    get: {
      tags: ['Store'],
      summary: "The signed-in customer's own home page rows",
      description:
        'Product ids, in order: recent (looked at in 30 days, not bought since, up to 12), buyAgain (from their orders, in stock, up to 12), ' +
        'forYou (12 picks: look-alikes of what they viewed and popular ones from their favourite categories, never what they bought; empty when there is too little to go on). 401 for guests.',
      responses: { '200': json(z.object({ recent: z.array(z.number()), buyAgain: z.array(z.number()), forYou: z.array(z.number()) })), ...errors(401) },
    },
  },
};
