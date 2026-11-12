import { applyBulk, type ProductBulk } from '../../lib/bulk.ts';
import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { banners, brands, productCategories, productImages, productRequests, products, searchQueries } from '../../db/schema/index.ts';
import { notFound } from '../../lib/errors.ts';
import { defaultLocationId } from '../admin/orders/service.ts';
import { AREAS, DISTRICTS, getSettings, listZones, LOCATIONS, quote } from '../admin/settings/service.ts';
import { activeCategories, cards, CURRENT_PRICE, facets, imagesById, inCategories, LOW_STOCK, SORTS } from './catalog.ts';
import { cartBody, productListQuery, productRequestBody, searchLogBody, suggestQuery } from './schemas.ts';
import { nameMatches, planSearch, productBySku, searchRank, searchWhere } from './search.ts';
import { checkCouponUse, cleanCode, codeGuard, CouponError, couponFor, couponLabel, findCoupon, shortfallMessage } from '../admin/coupons/service.ts';
import { currentCustomer } from './account/session.ts';
import { storeOrdersRouter } from './orders.ts';
import { accountRouter } from './account/routes.ts';
import { storeSeoRouter } from './seo.ts';
import { getIntegration } from '../admin/integrations/service.ts';

/** Public API for the website. Mounted at /v1/store. Shoppers may sign in (account routes). */
export const storeRouter = Router();

/** Browsers and the CDN may keep answers for a short while; the website revalidates on its own schedule. */
const cache = (res: Response, seconds = 60) => res.set('cache-control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`);

const all = sql`true`;
const and_ = (parts: (SQL | undefined)[]) => {
  const list = parts.filter((p): p is SQL => !!p);
  return list.length ? sql.join(list, sql` and `) : all;
};


// ---- Menus, footer, store details ----

storeRouter.get('/catalog', async (_req, res) => {
  const [cats, brandRows, store, google] = await Promise.all([
    activeCategories(),
    db.select().from(brands).where(eq(brands.isActive, true)).orderBy(sql`${brands.isFeatured} desc`, asc(sql`lower(${brands.name})`)),
    getSettings('store'),
    getIntegration('google'),
  ]);
  const g = google.settings;
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
    // Sign in with Google: Firebase's web settings (public by design). null when switched off.
    google: g.enabled && g.apiKey && g.authDomain && g.projectId && g.appId ? { apiKey: g.apiKey, authDomain: g.authDomain, projectId: g.projectId, appId: g.appId } : null,
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

/** Home page banners on now: active, inside their dates, with a picture. Up to 8 in the slider and 2 tiles. */
async function liveBanners() {
  const now = new Date();
  const rows = await db
    .select()
    .from(banners)
    .where(and(eq(banners.isActive, true), isNotNull(banners.imageId), or(isNull(banners.startsAt), lte(banners.startsAt, now)), or(isNull(banners.endsAt), gt(banners.endsAt, now))))
    .orderBy(asc(banners.sortOrder), asc(banners.id));
  const images = await imagesById(rows.flatMap((r) => [r.imageId, r.mobileImageId]));
  const view = (r: (typeof rows)[number]) => ({
    title: r.title,
    image: images.get(r.imageId!) ?? null,
    mobileImage: r.mobileImageId ? (images.get(r.mobileImageId) ?? null) : null,
    link: r.linkUrl,
  });
  const shown = (placement: 'hero' | 'tile', most: number) => rows.filter((r) => r.placement === placement).map(view).filter((b) => b.image).slice(0, most);
  return { hero: shown('hero', 8), tiles: shown('tile', 2) };
}

storeRouter.get('/home', async (_req, res) => {
  const cats = await activeCategories();
  const top = (cats.children.get(null) ?? []).filter((c) => cats.count(c.id) >= 3);
  const [shownBanners, deals, fresh, popular, ...rails] = await Promise.all([
    liveBanners(),
    cards(sql`c.regular_price > c.current_price and c.in_stock`, SORTS.deals, 12),
    cards(sql`c.in_stock`, SORTS.newest, 12),
    cards(sql`c.in_stock and c.sold > 0`, SORTS.popular, 12),
    ...top.map((c) => cards(and_([inCategories([c.id, ...cats.descendants(c.id)]), sql`c.in_stock`]), SORTS.popular, 12)),
  ]);
  cache(res, 60).json({
    banners: shownBanners,
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
  const plan = q.q ? await planSearch(q.q) : null;
  const brandFilter = q.brand.length ? sql`c.brand_slug in (${sql.join(q.brand.map((b) => sql`${b}`), sql`, `)})` : undefined;
  const priceFilter = and_([
    q.min !== undefined ? sql`c.current_price >= ${q.min}` : undefined,
    q.max !== undefined ? sql`c.current_price <= ${q.max}` : undefined,
  ]);
  // Searches show the best match first unless another order is chosen.
  const order = q.sort === 'relevance' || (!q.sort && plan) ? (plan ? searchRank(plan) : SORTS.popular) : SORTS[q.sort ?? 'popular'];

  const run = (search: SQL | undefined) => {
    const base = [categoryFilter, search, q.inStock ? sql`c.in_stock` : undefined, q.onSale ? sql`c.regular_price > c.current_price` : undefined];
    return Promise.all([cards(and_([...base, brandFilter, priceFilter]), order, q.pageSize, (q.page - 1) * q.pageSize), facets(and_(base))]);
  };
  let [list, filters] = await run(plan ? searchWhere(plan) : undefined);
  // Nothing has all the words: show what has some of them ("doms pencil box 24" -> DOMS and pencil boxes).
  let partial = false;
  if (plan && list.total === 0 && plan.groups.length > 1) {
    [list, filters] = await run(searchWhere(plan, false));
    partial = list.total > 0;
  }
  // A SKU typed exactly: the website opens that product.
  const sku = plan && q.page === 1 ? await productBySku(q.q!) : null;

  cache(res, 60).json({
    ...list,
    page: q.page,
    pageSize: q.pageSize,
    category,
    facets: filters,
    search: plan ? { query: plan.query, searched: plan.searched, corrected: plan.corrected, partial, sku } : null,
  });
});

/** A few requests per visitor per hour: enough for people, not for spam. */
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  // Only sent requests count: fixing a mistyped phone number is not held against anyone.
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'You have sent several requests already. Please call or WhatsApp us instead.' } },
});

/** "Request this product": a shopper asks for something the shop does not have. */
storeRouter.post('/product-requests', requestLimiter, async (req, res) => {
  const { website, ...input } = productRequestBody.parse(req.body);
  // The hidden box was filled: a bot. Answer as if saved, so it does not try again.
  if (!website) await db.insert(productRequests).values(input);
  res.status(201).json({ ok: true });
});

/** The browser reports each search made on the website, for the search report. */
storeRouter.post('/search-log', async (req, res) => {
  const body = searchLogBody.safeParse(req.body);
  if (body.success) await db.insert(searchQueries).values(body.data);
  res.status(204).end();
});

/** As-you-type search: a few products, matching categories and brands. */
storeRouter.get('/suggest', async (req, res) => {
  const { q } = suggestQuery.parse(req.query);
  const plan = await planSearch(q);
  if (!plan) {
    cache(res, 60).json({ products: [], total: 0, categories: [], brands: [], search: null });
    return;
  }
  const [cats, brandRows] = await Promise.all([
    activeCategories(),
    db.select({ name: brands.name, slug: brands.slug }).from(brands).where(eq(brands.isActive, true)),
  ]);
  let found = await cards(searchWhere(plan), searchRank(plan), 6);
  let partial = false;
  if (found.total === 0 && plan.groups.length > 1) {
    found = await cards(searchWhere(plan, false), searchRank(plan), 6);
    partial = found.total > 0;
  }
  cache(res, 60).json({
    products: found.items,
    total: found.total,
    categories: cats.all
      .filter((c) => nameMatches(c.name, plan) && cats.count(c.id) > 0)
      .slice(0, 4)
      .map((c) => ({ name: c.name, slug: c.slug, icon: c.icon })),
    brands: brandRows.filter((b) => nameMatches(b.name, plan)).slice(0, 3),
    search: { query: plan.query, searched: plan.searched, corrected: plan.corrected, partial },
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

  // "You may also need": in stock from the same category; a small category widens to its parent
  // ("School Bags" -> "School Supplies") until there are at least 4.
  let related: { items: Awaited<ReturnType<typeof cards>>['items'] } = { items: [] };
  for (let c = primary; c; c = c.parentId ? cats.byId.get(c.parentId) : undefined) {
    related = await cards(and_([inCategories([c.id, ...cats.descendants(c.id)]), sql`c.id <> ${product.id}`, sql`c.in_stock`]), SORTS.popular, 12);
    if (related.items.length >= 4) break;
  }

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
        bulk: ProductBulk;
      }>(sql`
        select v.id, p.id as product_id, p.slug, p.name, p.status, p.options, p.bulk_discount as bulk, v.option1, v.option2, v.option3, v.price,
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

  // Bulk discounts: worked out on what can be ordered, the same way as when the order is placed.
  const checkout = await getSettings('checkout');
  const priced = lines.filter((l): l is Extract<typeof l, { price: number }> => 'price' in l && l.quantity > 0);
  const bulk = applyBulk(
    priced.map((l) => ({ productId: l.productId, quantity: l.quantity, price: l.price, onSale: l.regularPrice !== null })),
    checkout.bulk,
    new Map(priced.map((l) => [l.productId, byId.get(l.variantId)!.bulk])),
  );
  // Matched by line (not by item id), so even the same item sent twice gets its own numbers.
  const withBulk = new Map<object, (typeof bulk)[number]>(priced.map((l, k) => [l, bulk[k]!]));
  const shown = lines.map((l) => {
    const b = withBulk.get(l);
    if (!('price' in l) || !b) return l;
    // lineTotal: after the discount. bulk: what it took off, and the next step ("add 3 more for 10% off").
    return { ...l, lineTotal: b.lineTotal, bulk: { percent: b.percent, discount: b.discount, next: b.next } };
  });
  const ok = shown.filter((l): l is Extract<typeof l, { price: number }> => 'price' in l && l.quantity > 0);
  const subtotal = Math.round(ok.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  const bulkSavings = bulk.reduce((s, b) => s + b.discount, 0);
  const weightKg = ok.reduce((s, l) => s + (l.weightGrams ?? 0) * l.quantity, 0) / 1000;

  let delivery = null;
  if (input.districtId && DISTRICTS.has(input.districtId)) {
    const areaId = input.areaId && AREAS.get(input.areaId)?.districtId === input.districtId ? input.areaId : null;
    const zones = await listZones();
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

  // subtotal: after bulk discounts (bulkSavings is what they took off).
  // The coupon: worked out like the order will (the per-person rules need a phone, so a signed-in
  // shopper gets them now and everyone else when placing the order).
  let coupon: StoreCartCoupon | null = null;
  const code = input.couponCode ? cleanCode(input.couponCode) : '';
  if (code) {
    if (!codeGuard.allowed(req.ip)) {
      coupon = { code, ok: false, message: 'Too many wrong codes. Please wait a few minutes and try again.', short: null, itemsOff: 0, deliveryOff: 0, label: null, checkedAtOrder: false };
    } else {
      try {
        const me = await currentCustomer(req);
        const c = await findCoupon(db, code);
        const use = await checkCouponUse(db, c, { phone: me?.phone ?? null, customerId: me?.id ?? null });
        const result = await couponFor(db, c!, ok.map((l) => ({ productId: l.productId, lineTotal: l.lineTotal, onSale: l.regularPrice !== null, bulkPercent: ('bulk' in l && l.bulk.percent) || null })), delivery?.fee ?? null);
        coupon = {
          code: c!.code,
          ok: result.ok,
          message: result.ok ? null : shortfallMessage(result),
          short: result.short,
          itemsOff: result.itemsOff,
          deliveryOff: result.deliveryOff,
          label: couponLabel(c!),
          checkedAtOrder: !use.phoneChecked,
        };
      } catch (err) {
        if (!(err instanceof CouponError)) throw err;
        if (err.reason === 'unknown') codeGuard.failed(req.ip);
        coupon = { code, ok: false, message: err.message, short: null, itemsOff: 0, deliveryOff: 0, label: null, checkedAtOrder: false };
      }
    }
  }

  res.json({ lines: shown, itemCount: ok.reduce((s, l) => s + l.quantity, 0), subtotal, bulkSavings, weightKg, delivery, coupon });
});

/** The coupon part of a cart check. itemsOff and deliveryOff are already worked out; the total is subtotal − itemsOff + (delivery − deliveryOff). */
interface StoreCartCoupon {
  code: string;
  ok: boolean;
  /** Why it gives nothing now ("Add ৳120 more to use this code"). */
  message: string | null;
  short: number | null;
  itemsOff: number;
  deliveryOff: number;
  /** "10% off", "৳100 off", "Free delivery". */
  label: string | null;
  /** Rules for one person (once per customer, first orders, private) are checked when the order is placed. */
  checkedAtOrder: boolean;
}

// ---- Orders (checkout) ----

storeRouter.use('/orders', storeOrdersRouter);
storeRouter.use(accountRouter);
storeRouter.use(storeSeoRouter);
