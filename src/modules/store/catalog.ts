import { inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { media } from '../../db/schema/index.ts';
import { mediaView } from '../admin/media/view.ts';
import { defaultLocationId } from '../admin/orders/service.ts';

/**
 * Read-only queries for the website. Only active products, categories and brands are shown.
 * Prices are retail prices as of now (sale price while a sale runs); stock is counted at the
 * default stock location, which website orders take from.
 */

// ---- Images ----

/** What the website needs of an image. */
export const publicImage = (m: typeof media.$inferSelect) => {
  const v = mediaView(m);
  return { urls: v.urls, width: v.width, height: v.height, alt: v.alt };
};
export type PublicImage = ReturnType<typeof publicImage>;

export async function imagesById(ids: (number | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  const rows = wanted.length ? await db.select().from(media).where(inArray(media.id, wanted)) : [];
  return new Map(rows.map((m) => [m.id, publicImage(m)]));
}

// ---- Product cards ----

/** Today's retail price of variant "v". */
export const CURRENT_PRICE = sql`case when v.sale_price is not null and v.sale_price < v.price
  and (v.sale_starts_at is null or v.sale_starts_at <= now())
  and (v.sale_ends_at is null or v.sale_ends_at >= now()) then v.sale_price else v.price end`;

/** "Only 3 left" is shown at or below this. */
export const LOW_STOCK = 5;

export type CardRow = {
  id: string;
  slug: string;
  name: string;
  brand_name: string | null;
  brand_slug: string | null;
  image_id: string | null;
  variant_id: string;
  current_price: string;
  regular_price: string;
  variant_count: string;
  in_stock: boolean;
  stock_left: string | null;
  is_new: boolean;
};

/**
 * Products with what a card shows: the cheapest variant's price (and its normal price when on sale),
 * how many variants, and whether anything can be ordered. `where` and `order` use the aliases
 * p (product), b (brand), c (card values: current_price, in_stock, ...) and s (units sold in 90 days).
 */
export function cardsQuery(locationId: number, where: SQL, order: SQL, limit: number, offset = 0) {
  return sql`
    ${cardsCte(locationId)}
    select *, count(*) over () as total_count from cards c
    where ${where}
    -- Out-of-stock products last; the id makes the order stable, so pages never repeat or skip a product.
    order by c.in_stock desc, ${order}, c.id desc
    limit ${limit} offset ${offset}`;
}

/** The `cards` table expression, for card lists and for filter counts. */
export function cardsCte(locationId: number) {
  return sql`
    with cards as (
      select p.id, p.slug, p.name, b.name as brand_name, b.slug as brand_slug,
        (select pi.media_id from product_images pi where pi.product_id = p.id order by pi.position limit 1) as image_id,
        c.variant_id, c.current_price, c.regular_price, c.variant_count, c.in_stock, c.stock_left,
        coalesce(p.published_at, p.created_at) > now() - interval '30 days' as is_new,
        coalesce(p.published_at, p.created_at) as published, coalesce(s.sold, 0) as sold
      from products p
      left join brands b on b.id = p.brand_id and b.is_active
      cross join lateral (
        select
          (array_agg(x.id order by x.cur, x.position))[1] as variant_id,
          min(x.cur) as current_price,
          (array_agg(x.price order by x.cur, x.position))[1] as regular_price,
          count(*) as variant_count,
          bool_or(x.available) as in_stock,
          sum(x.qty) filter (where x.track_stock and not x.allow_backorder) as stock_left
        from (
          select v.id, v.position, v.price, v.track_stock, v.allow_backorder, ${CURRENT_PRICE} as cur,
            coalesce(il.quantity, 0) as qty,
            (not v.track_stock or v.allow_backorder or coalesce(il.quantity, 0) > 0) as available
          from product_variants v
          left join inventory_levels il on il.variant_id = v.id and il.location_id = ${locationId}
          where v.product_id = p.id
        ) x
      ) c
      left join lateral (
        select sum(oi.quantity) as sold from order_items oi join orders o on o.id = oi.order_id
        where oi.product_id = p.id and o.status not in ('cancelled', 'returned') and o.created_at > now() - interval '90 days'
      ) s on true
      where p.status = 'active'
    )`;
}

/** Brands and the price range among products that match `where` (which must not filter by brand or price). */
export async function facets(where: SQL) {
  const locationId = await defaultLocationId();
  const [{ rows: brandRows }, { rows: priceRows }] = await Promise.all([
    db.execute<{ slug: string; name: string; n: string }>(sql`
      ${cardsCte(locationId)}
      select c.brand_slug as slug, c.brand_name as name, count(*) as n from cards c
      where ${where} and c.brand_slug is not null group by c.brand_slug, c.brand_name order by count(*) desc, c.brand_name`),
    db.execute<{ min: string | null; max: string | null }>(sql`
      ${cardsCte(locationId)}
      select min(c.current_price) as min, max(c.current_price) as max from cards c where ${where}`),
  ]);
  const price = priceRows[0];
  return {
    brands: brandRows.map((b) => ({ slug: b.slug, name: b.name, count: Number(b.n) })),
    price: price?.min === null || !price ? null : { min: Math.floor(Number(price.min)), max: Math.ceil(Number(price.max)) },
  };
}

/** Every list puts products that can be bought first, then this order (see cardsQuery). */
export const SORTS = {
  popular: sql`c.sold desc, c.published desc`,
  newest: sql`c.published desc`,
  price_asc: sql`c.current_price asc, c.published desc`,
  price_desc: sql`c.current_price desc, c.published desc`,
  name: sql`lower(c.name) asc`,
  /** Biggest discount first. */
  deals: sql`(c.regular_price - c.current_price) / nullif(c.regular_price, 0) desc`,
} as const;
export type SortKey = keyof typeof SORTS;

export async function cards(where: SQL, order: SQL, limit: number, offset = 0) {
  const locationId = await defaultLocationId();
  const { rows } = await db.execute<CardRow & { total_count: string }>(cardsQuery(locationId, where, order, limit, offset));
  // Up to 3 more pictures per product, shown when the card is pointed at (only for this page's products).
  const ids = rows.map((r) => Number(r.id));
  const { rows: extra } = ids.length
    ? await db.execute<{ product_id: string; media_id: string }>(sql`
        select x.product_id, x.media_id from (
          select pi.product_id, pi.media_id, row_number() over (partition by pi.product_id order by pi.position) as n
          from product_images pi where pi.product_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        ) x where x.n between 2 and 4 order by x.product_id, x.n`)
    : { rows: [] };
  const images = await imagesById([...rows.map((r) => (r.image_id ? Number(r.image_id) : null)), ...extra.map((e) => Number(e.media_id))]);
  const moreOf = (productId: number) =>
    extra.filter((e) => Number(e.product_id) === productId).flatMap((e) => images.get(Number(e.media_id)) ?? []);
  let total = rows.length ? Number(rows[0]!.total_count) : 0;
  // A page past the end has no rows to carry the count: count separately, so the real total is known.
  if (!rows.length && offset > 0) {
    const { rows: counted } = await db.execute<{ n: string }>(sql`${cardsCte(locationId)} select count(*) as n from cards c where ${where}`);
    total = Number(counted[0]?.n ?? 0);
  }
  return {
    total,
    items: rows.map((r) => {
      const price = Number(r.current_price);
      const regular = Number(r.regular_price);
      const stockLeft = r.stock_left === null ? null : Number(r.stock_left);
      return {
        id: Number(r.id),
        slug: r.slug,
        name: r.name,
        brand: r.brand_name ? { name: r.brand_name, slug: r.brand_slug! } : null,
        image: r.image_id ? (images.get(Number(r.image_id)) ?? null) : null,
        /** More pictures (up to 3), for the card's picture-on-hover. */
        moreImages: moreOf(Number(r.id)),
        price,
        regularPrice: regular > price ? regular : null,
        /** Add straight from the card when there is only one variant. */
        variantId: Number(r.variant_count) === 1 ? Number(r.variant_id) : null,
        variantCount: Number(r.variant_count),
        inStock: r.in_stock,
        lowStock: r.in_stock && stockLeft !== null && stockLeft <= LOW_STOCK ? stockLeft : null,
        isNew: r.is_new,
      };
    }),
  };
}

export type ProductCard = Awaited<ReturnType<typeof cards>>['items'][number];

// ---- Categories ----

export interface CategoryNode {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
  imageId: number | null;
  icon: string | null;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
}

/** Active categories (a category under an inactive one is hidden too), with product counts including sub-categories. */
export async function activeCategories() {
  const { rows } = await db.execute<{
    id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    description: string | null;
    image_id: string | null;
    icon: string | null;
    sort_order: number;
    seo_title: string | null;
    seo_description: string | null;
  }>(sql`select * from categories cat where cat.is_active order by cat.sort_order, lower(cat.name)`);
  const { rows: links } = await db.execute<{ product_id: string; category_id: string }>(sql`
    select pc.product_id, pc.category_id from product_categories pc join products p on p.id = pc.product_id
    where p.status = 'active'`);
  const all = rows.map((r) => ({
    id: Number(r.id),
    parentId: r.parent_id ? Number(r.parent_id) : null,
    name: r.name,
    slug: r.slug,
    description: r.description,
    imageId: r.image_id ? Number(r.image_id) : null,
    icon: r.icon,
    sortOrder: r.sort_order,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
  }));
  const byId = new Map(all.map((c) => [c.id, c]));
  // Drop categories whose parent is inactive (not in the list).
  const visible = all.filter((c) => {
    for (let p = c.parentId; p !== null; p = byId.get(p)?.parentId ?? null) if (!byId.has(p)) return false;
    return true;
  });
  const children = new Map<number | null, typeof visible>();
  for (const c of visible) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  const descendants = (id: number): number[] => (children.get(id) ?? []).flatMap((c) => [c.id, ...descendants(c.id)]);

  // Products per category, counting those in sub-categories too, each product once.
  const productsIn = new Map<number, Set<number>>();
  for (const l of links) {
    const cid = Number(l.category_id);
    productsIn.set(cid, (productsIn.get(cid) ?? new Set()).add(Number(l.product_id)));
  }
  const count = (id: number) => new Set([id, ...descendants(id)].flatMap((cid) => [...(productsIn.get(cid) ?? [])])).size;

  return { all: visible, children, descendants, count, byId: new Map(visible.map((c) => [c.id, c])) };
}

export const inCategories = (ids: number[]) =>
  sql`exists (select 1 from product_categories pc where pc.product_id = c.id and pc.category_id in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}))`;
