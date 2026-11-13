import { Router, type Request } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { forbidden } from '../../lib/errors.ts';
import { isApprovedBusiness, wholesaleTermsFor } from '../admin/customers/service.ts';
import { getSettings } from '../admin/settings/service.ts';
import { currentCustomer } from './account/session.ts';
import { CURRENT_PRICE } from './catalog.ts';

/**
 * Wholesale prices on the website. Pages and product lists are the same for everyone (and kept by
 * the CDN), so they show retail prices; for a signed-in approved business the browser then asks
 * here for its prices and swaps them in. Wholesale prices never appear in a public answer.
 *
 * A product's wholesale price is its variant's wholesale price, or the retail price (today's sale
 * price included) when it has none — the same rule as wholesale orders.
 */

/** Today's wholesale price of variant "v" (falls back to the retail price). */
export const WHOLESALE_PRICE = sql`coalesce(v.wholesale_price, ${CURRENT_PRICE})`;

/** The signed-in customer when it is an approved business (not blocked), else null. */
export async function businessOf(req: Request) {
  const c = await currentCustomer(req);
  return c && isApprovedBusiness(c) ? c : null;
}

/** The business's terms: the shop's, with its own on top. */
export async function termsOf(c: NonNullable<Awaited<ReturnType<typeof businessOf>>>) {
  const shop = await getSettings('checkout');
  return wholesaleTermsFor(c, shop.wholesale);
}

const ids = z
  .string()
  .optional()
  .transform((v) =>
    [...new Set((v ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200),
  );
const pricesQuery = z.object({ products: ids, variants: ids });

export const wholesaleRouter = Router();

/**
 * Wholesale prices for products (the cheapest option, as on cards) and for variants (product page).
 * `regularPrice`: the retail price when it is higher, to show crossed out.
 */
wholesaleRouter.get('/me/wholesale-prices', async (req, res) => {
  const business = await businessOf(req);
  if (!business) throw forbidden('Wholesale prices are for approved business accounts');
  const q = pricesQuery.parse(req.query);
  const list = (values: number[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const [products, variants] = await Promise.all([
    q.products.length
      ? db.execute<{ product_id: string; price: string; retail: string }>(sql`
          select distinct on (v.product_id) v.product_id, ${WHOLESALE_PRICE} as price, ${CURRENT_PRICE} as retail
          from product_variants v join products p on p.id = v.product_id
          where v.product_id in (${list(q.products)}) and p.status = 'active'
          order by v.product_id, ${WHOLESALE_PRICE}, v.position, v.id`)
      : { rows: [] },
    q.variants.length
      ? db.execute<{ id: string; price: string; retail: string }>(sql`
          select v.id, ${WHOLESALE_PRICE} as price, ${CURRENT_PRICE} as retail
          from product_variants v join products p on p.id = v.product_id
          where v.id in (${list(q.variants)}) and p.status = 'active'`)
      : { rows: [] },
  ]);
  const view = (price: string, retail: string) => ({ price: Number(price), regularPrice: Number(retail) > Number(price) ? Number(retail) : null });
  res.set('cache-control', 'private, no-store').json({
    products: Object.fromEntries(products.rows.map((r) => [r.product_id, view(r.price, r.retail)])),
    variants: Object.fromEntries(variants.rows.map((r) => [r.id, view(r.price, r.retail)])),
  });
});
