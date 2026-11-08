import { Router, type Response } from 'express';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { brands, productCategories, productImages, products } from '../../db/schema/index.ts';
import { notFound } from '../../lib/errors.ts';
import { defaultLocationId } from '../admin/orders/service.ts';
import { AREAS, DISTRICTS, getSettings, listZones, LOCATIONS, quote } from '../admin/settings/service.ts';
import { activeCategories, cards, CURRENT_PRICE, facets, imagesById, inCategories, LOW_STOCK, SORTS } from './catalog.ts';
import { cartBody, productListQuery, suggestQuery } from './schemas.ts';

/** Public API for the website. Read-only, no sign-in. Mounted at /v1/store. */
export const storeRouter = Router();

/** Browsers and the CDN may keep answers for a short while; the website revalidates on its own schedule. */
const cache = (res: Response, seconds = 60) => res.set('cache-control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`);

const all = sql`true`;
const and_ = (parts: (SQL | undefined)[]) => {
  const list = parts.filter((p): p is SQL => !!p);
  return list.length ? sql.join(list, sql` and `) : all;
};

/** Each word must appear in the name, brand, a tag or a SKU. */
const searchFilter = (q: string) =>
  and_(
    q
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((word) => {
        const like = `%${word.replace(/[%_\\]/g, '\\$&')}%`;
        return sql`(c.name ilike ${like} or coalesce(c.brand_name, '') ilike ${like}
          or exists (select 1 from products p2 where p2.id = c.id and array_to_string(p2.tags, ' ') ilike ${like})
          or exists (select 1 from product_variants v2 where v2.product_id = c.id and v2.sku ilike ${like}))`;
      }),
  );

// ---- Menus, footer, store details ----

storeRouter.get('/catalog', async (_req, res) => {
  const [cats, brandRows, store] = await Promise.all([
    activeCategories(),
    db.select().from(brands).where(eq(brands.isActive, true)).orderBy(sql`${brands.isFeatured} desc`, asc(sql`lower(${brands.name})`)),
    getSettings('store'),
  ]);
  const images = await imagesById([...cats.all.map((c) => c.imageId), ...brandRows.map((b) => b.imageId), store.logoImageId]);
  const node = (c: (typeof cats.all)[number]): unknown => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    icon: c.icon,
    image: c.imageId ? (images.get(c.imageId) ?? null) : null,
    productCount: cats.count(c.id),
    children: (cats.children.get(c.id) ?? []).filter((x) => cats.count(x.id) > 0).map(node),
  });
  cache(res, 300).json({
    store: {
      name: store.name,
      tagline: store.tagline,
      phone: store.phone,
      whatsapp: store.whatsapp,
      email: store.email,
      address: store.address,
      openingHours: store.openingHours,
      logo: store.logoImageId ? (images.get(store.logoImageId) ?? null) : null,
      social: { facebook: store.facebook, instagram: store.instagram, youtube: store.youtube, tiktok: store.tiktok },
    },
    // Empty categories are hidden.
    categories: (cats.children.get(null) ?? []).filter((c) => cats.count(c.id) > 0).map(node),
    brands: brandRows.map((b) => ({
      name: b.name,
      slug: b.slug,
      icon: b.icon,
      image: b.imageId ? (images.get(b.imageId) ?? null) : null,
      isFeatured: b.isFeatured,
    })),
  });
});

/** Districts and areas of Bangladesh, for "Deliver to" and addresses. */
storeRouter.get('/places', (_req, res) => {
  cache(res, 86_400).json(LOCATIONS);
});

// ---- Home page ----

storeRouter.get('/home', async (_req, res) => {
  const cats = await activeCategories();
  const top = (cats.children.get(null) ?? []).filter((c) => cats.count(c.id) >= 3);
  const [deals, fresh, popular, ...rails] = await Promise.all([
    cards(sql`c.regular_price > c.current_price and c.in_stock`, SORTS.deals, 12),
    cards(sql`c.in_stock`, SORTS.newest, 12),
    cards(sql`c.in_stock and c.sold > 0`, SORTS.popular, 12),
    ...top.map((c) => cards(and_([inCategories([c.id, ...cats.descendants(c.id)]), sql`c.in_stock`]), SORTS.popular, 12)),
  ]);
  cache(res, 60).json({
    deals: deals.items,
    newArrivals: fresh.items,
    bestSellers: popular.items,
    categoryRows: top
      .map((c, i) => ({ category: { name: c.name, slug: c.slug, icon: c.icon }, products: rails[i]!.items }))
      .filter((row) => row.products.length >= 3),
  });
});

// ---- Product lists: category, brand, search, deals ----

storeRouter.get('/products', async (req, res) => {
  const q = productListQuery.parse(req.query);
  const cats = await activeCategories();

  let category = null;
  let categoryFilter: SQL | undefined;
  if (q.category) {
    const found = cats.all.find((c) => c.slug === q.category);
    if (!found) throw notFound('Category not found');
    categoryFilter = inCategories([found.id, ...cats.descendants(found.id)]);
    const path = [];
    for (let c: typeof found | undefined = found; c; c = c.parentId ? cats.byId.get(c.parentId) : undefined) path.unshift(c);
    const images = await imagesById([found.imageId]);
    category = {
      name: found.name,
      slug: found.slug,
      description: found.description,
      icon: found.icon,
      image: found.imageId ? (images.get(found.imageId) ?? null) : null,
      seoTitle: found.seoTitle,
      seoDescription: found.seoDescription,
      path: path.map((c) => ({ name: c.name, slug: c.slug })),
      children: (cats.children.get(found.id) ?? [])
        .filter((c) => cats.count(c.id) > 0)
        .map((c) => ({ name: c.name, slug: c.slug, icon: c.icon, productCount: cats.count(c.id) })),
    };
  }
  const base = [
    categoryFilter,
    q.q ? searchFilter(q.q) : undefined,
    q.inStock ? sql`c.in_stock` : undefined,
    q.onSale ? sql`c.regular_price > c.current_price` : undefined,
  ];
  const brandFilter = q.brand.length ? sql`c.brand_slug in (${sql.join(q.brand.map((b) => sql`${b}`), sql`, `)})` : undefined;
  const priceFilter = and_([
    q.min !== undefined ? sql`c.current_price >= ${q.min}` : undefined,
    q.max !== undefined ? sql`c.current_price <= ${q.max}` : undefined,
  ]);

  const [list, filters] = await Promise.all([
    cards(and_([...base, brandFilter, priceFilter]), SORTS[q.sort], q.pageSize, (q.page - 1) * q.pageSize),
    facets(and_(base)),
  ]);
  cache(res, 60).json({ ...list, page: q.page, pageSize: q.pageSize, category, facets: filters });
});

/** As-you-type search: a few products, matching categories and brands. */
storeRouter.get('/suggest', async (req, res) => {
  const { q } = suggestQuery.parse(req.query);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const [found, cats, brandRows] = await Promise.all([
    cards(searchFilter(q), sql`c.in_stock desc, c.sold desc, c.published desc`, 6),
    activeCategories(),
    db.select({ name: brands.name, slug: brands.slug }).from(brands).where(eq(brands.isActive, true)),
  ]);
  cache(res, 60).json({
    products: found.items,
    total: found.total,
    categories: cats.all
      .filter((c) => matches(c.name) && cats.count(c.id) > 0)
      .slice(0, 4)
      .map((c) => ({ name: c.name, slug: c.slug, icon: c.icon })),
    brands: brandRows.filter((b) => matches(b.name)).slice(0, 3),
  });
});

// ---- Product page ----

storeRouter.get('/products/:slug', async (req, res) => {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, String(req.params.slug)), eq(products.status, 'active')));
  if (!product) throw notFound('Product not found');

  const locationId = await defaultLocationId();
  const [gallery, variantRows, links, cats, brand] = await Promise.all([
    db.select().from(productImages).where(eq(productImages.productId, product.id)).orderBy(asc(productImages.position)),
    db.execute<{
      id: string;
      option1: string | null;
      option2: string | null;
      option3: string | null;
      sku: string | null;
      price: string;
      cur: string;
      // Raw queries give timestamps as text.
      sale_ends_at: string | null;
      weight_grams: number | null;
      image_id: string | null;
      track_stock: boolean;
      allow_backorder: boolean;
      qty: number;
    }>(sql`
      select v.id, v.option1, v.option2, v.option3, v.sku, v.price, ${CURRENT_PRICE} as cur, v.sale_ends_at, v.weight_grams,
        v.image_id, v.track_stock, v.allow_backorder, coalesce(il.quantity, 0) as qty
      from product_variants v
      left join inventory_levels il on il.variant_id = v.id and il.location_id = ${locationId}
      where v.product_id = ${product.id} order by v.position, v.id`),
    db.select().from(productCategories).where(eq(productCategories.productId, product.id)),
    activeCategories(),
    product.brandId ? db.select().from(brands).where(and(eq(brands.id, product.brandId), eq(brands.isActive, true))) : Promise.resolve([]),
  ]);

  const variants = variantRows.rows;
  const images = await imagesById([...gallery.map((g) => g.mediaId), ...variants.map((v) => (v.image_id ? Number(v.image_id) : null))]);

  // Breadcrumbs follow the main category.
  const primary = cats.byId.get(Number((links.find((l) => l.isPrimary) ?? links[0])?.categoryId));
  const path = [];
  for (let c = primary; c; c = c.parentId ? cats.byId.get(c.parentId) : undefined) path.unshift({ name: c.name, slug: c.slug });

  const related = primary
    ? await cards(
        and_([inCategories([primary.id, ...cats.descendants(primary.id)]), sql`c.id <> ${product.id}`, sql`c.in_stock`]),
        SORTS.popular,
        12,
      )
    : { items: [] };

  cache(res, 60).json({
    id: product.id,
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    description: product.description,
    brand: brand[0] ? { name: brand[0].name, slug: brand[0].slug } : null,
    tags: product.tags,
    options: product.options,
    specs: product.specs,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    images: gallery.map((g) => images.get(g.mediaId)).filter(Boolean),
    categoryPath: path,
    variants: variants.map((v) => {
      const price = Number(v.cur);
      const regular = Number(v.price);
      const limited = v.track_stock && !v.allow_backorder;
      return {
        id: Number(v.id),
        values: [v.option1, v.option2, v.option3].slice(0, product.options.length),
        sku: v.sku,
        price,
        regularPrice: regular > price ? regular : null,
        saleEndsAt: regular > price ? v.sale_ends_at : null,
        weightGrams: v.weight_grams,
        image: v.image_id ? (images.get(Number(v.image_id)) ?? null) : null,
        inStock: !limited || v.qty > 0,
        /** How many can be ordered (null = no limit). */
        maxQuantity: limited ? Math.max(0, v.qty) : null,
        lowStock: limited && v.qty > 0 && v.qty <= LOW_STOCK ? v.qty : null,
      };
    }),
    related: related.items,
  });
});

// ---- Cart ----

/**
 * Checks a cart kept in the browser: today's prices, what is still available, and the delivery charge
 * with free-delivery progress when the place is known. Nothing is saved.
 */
storeRouter.post('/cart', async (req, res) => {
  const input = cartBody.parse(req.body);
  const locationId = await defaultLocationId();
  const ids = input.items.map((i) => i.variantId);
  const { rows } = ids.length
    ? await db.execute<{
        id: string;
        product_id: string;
        slug: string;
        name: string;
        status: string;
        options: { name: string }[];
        option1: string | null;
        option2: string | null;
        option3: string | null;
        price: string;
        cur: string;
        weight_grams: number | null;
        track_stock: boolean;
        allow_backorder: boolean;
        qty: number;
        image_id: string | null;
      }>(sql`
        select v.id, p.id as product_id, p.slug, p.name, p.status, p.options, v.option1, v.option2, v.option3, v.price,
          ${CURRENT_PRICE} as cur, v.weight_grams, v.track_stock, v.allow_backorder, coalesce(il.quantity, 0) as qty,
          coalesce(v.image_id, (select pi.media_id from product_images pi where pi.product_id = p.id order by pi.position limit 1)) as image_id
        from product_variants v join products p on p.id = v.product_id
        left join inventory_levels il on il.variant_id = v.id and il.location_id = ${locationId}
        where v.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
    : { rows: [] };
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const images = await imagesById(rows.map((r) => (r.image_id ? Number(r.image_id) : null)));

  const lines = input.items.map((item) => {
    const v = byId.get(item.variantId);
    if (!v || v.status !== 'active') return { variantId: item.variantId, quantity: item.quantity, problem: 'gone' as const };
    // Same rule as the product cards, worked out by the database.
    const price = Number(v.cur);
    const limited = v.track_stock && !v.allow_backorder;
    const available = limited ? Math.max(0, v.qty) : null;
    const quantity = available === null ? item.quantity : Math.min(item.quantity, available);
    return {
      variantId: item.variantId,
      productId: Number(v.product_id),
      slug: v.slug,
      name: v.name,
      variantLabel: [v.option1, v.option2, v.option3].filter(Boolean).join(' / ') || null,
      image: v.image_id ? (images.get(Number(v.image_id)) ?? null) : null,
      price,
      regularPrice: Number(v.price) > price ? Number(v.price) : null,
      quantity,
      maxQuantity: available,
      weightGrams: v.weight_grams,
      lineTotal: Math.round(price * quantity * 100) / 100,
      problem: available === 0 ? ('out_of_stock' as const) : quantity < item.quantity ? ('reduced' as const) : null,
    };
  });

  const ok = lines.filter((l): l is Extract<typeof l, { price: number }> => 'price' in l && l.quantity > 0);
  const subtotal = Math.round(ok.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  const weightKg = ok.reduce((s, l) => s + (l.weightGrams ?? 0) * l.quantity, 0) / 1000;

  let delivery = null;
  if (input.districtId && DISTRICTS.has(input.districtId)) {
    const areaId = input.areaId && AREAS.get(input.areaId)?.districtId === input.districtId ? input.areaId : null;
    const [zones, checkout] = await Promise.all([listZones(), getSettings('checkout')]);
    const q = quote(zones, checkout, { districtId: input.districtId, areaId, subtotal, weightKg, wholesale: false });
    const zone = zones.find((z) => z.id === q.zone?.id);
    delivery = {
      zone: q.zone?.name ?? null,
      deliveryTime: q.zone?.deliveryTime ?? null,
      fee: q.fee,
      freeAbove: zone?.freeAbove ?? null,
      /** How much more for free delivery (null when the zone has no free delivery or it is reached). */
      toFree: zone?.freeAbove && subtotal < zone.freeAbove ? Math.round((zone.freeAbove - subtotal) * 100) / 100 : null,
    };
  }

  res.json({ lines, itemCount: ok.reduce((s, l) => s + l.quantity, 0), subtotal, weightKg, delivery });
});
