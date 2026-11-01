import { Router } from 'express';
import { and, asc, count, desc, eq, exists, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import {
  brands,
  inventoryLevels,
  productCategories,
  productImages,
  products,
  productVariants,
  stockLocations,
} from '../../../db/schema/index.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { withImages } from '../media/view.ts';
import { productBody, productBulkBody, productListQuery, PRODUCT_STATUSES, stockUpdateBody } from './schemas.ts';
import { bulkUpdate, duplicateProduct, getProduct, saveProduct, updateStock } from './service.ts';

/** Mounted behind requireAdmin + requireModule('products'). */
export const productsRouter = Router();

/** "50%_off" -> "50\%\_off", so search text is matched literally. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

productsRouter.get('/', async (req, res) => {
  const q = productListQuery.parse(req.query);

  const filters: (SQL | undefined)[] = [
    q.brandId ? eq(products.brandId, q.brandId) : undefined,
    q.categoryId
      ? exists(
          db
            .select({ one: sql`1` })
            .from(productCategories)
            .where(and(eq(productCategories.productId, products.id), eq(productCategories.categoryId, q.categoryId))),
        )
      : undefined,
  ];
  if (q.search) {
    const pattern = `%${escapeLike(q.search)}%`;
    filters.push(
      or(
        ilike(products.name, pattern),
        exists(
          db
            .select({ one: sql`1` })
            .from(productVariants)
            .where(and(eq(productVariants.productId, products.id), ilike(productVariants.sku, pattern))),
        ),
      ),
    );
  }
  // Stock of one variant, all locations together.
  const variantQty = sql`coalesce((select sum(${inventoryLevels.quantity}) from ${inventoryLevels} where ${inventoryLevels.variantId} = ${productVariants.id}), 0)`;
  if (q.stock) {
    filters.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.productId, products.id),
              eq(productVariants.trackStock, true),
              q.stock === 'out'
                ? sql`${variantQty} <= 0`
                : sql`${variantQty} > 0 and ${variantQty} <= ${productVariants.lowStockThreshold}`,
            ),
          ),
      ),
    );
  }
  const where = and(...filters, q.status ? eq(products.status, q.status) : undefined);

  const levelSums = db
    .select({
      variantId: inventoryLevels.variantId,
      quantity: sql<number>`sum(${inventoryLevels.quantity})`.as('quantity'),
    })
    .from(inventoryLevels)
    .groupBy(inventoryLevels.variantId)
    .as('level_sums');
  const qty = sql`coalesce(${levelSums.quantity}, 0)`;

  const variantStats = db
    .select({
      productId: productVariants.productId,
      variantCount: count().as('variant_count'),
      priceMin: sql<number>`min(${productVariants.price})`.mapWith(Number).as('price_min'),
      priceMax: sql<number>`max(${productVariants.price})`.mapWith(Number).as('price_max'),
      onSale: sql<boolean>`bool_or(${productVariants.salePrice} is not null)`.as('on_sale'),
      tracked: sql<boolean>`bool_or(${productVariants.trackStock})`.as('tracked'),
      totalStock: sql<number>`sum(${qty}) filter (where ${productVariants.trackStock})`.mapWith(Number).as('total_stock'),
      variantsOut: sql<number>`count(*) filter (where ${productVariants.trackStock} and ${qty} <= 0)`
        .mapWith(Number)
        .as('variants_out'),
      variantsLow: sql<number>`count(*) filter (where ${productVariants.trackStock} and ${qty} > 0 and ${qty} <= ${productVariants.lowStockThreshold})`
        .mapWith(Number)
        .as('variants_low'),
    })
    .from(productVariants)
    .leftJoin(levelSums, eq(levelSums.variantId, productVariants.id))
    .groupBy(productVariants.productId)
    .as('variant_stats');

  const mainImageId = sql<number | null>`(
    select ${productImages.mediaId} from ${productImages}
    where ${productImages.productId} = ${products.id}
    order by ${productImages.position} limit 1
  )`.mapWith((v) => (v === null ? null : Number(v)));

  const orderBy =
    q.sort === 'name'
      ? [asc(products.name)]
      : q.sort === 'price'
        ? [asc(variantStats.priceMin), asc(products.name)]
        : q.sort === 'stock'
          ? [sql`${variantStats.totalStock} asc nulls last`, asc(products.name)]
          : [desc(products.updatedAt)];

  const [rows, [totalRow], statusRows] = await Promise.all([
    db
      .select({
        id: products.id,
        name: products.name,
        slug: products.slug,
        status: products.status,
        updatedAt: products.updatedAt,
        imageId: mainImageId,
        brandId: brands.id,
        brandName: brands.name,
        variantCount: variantStats.variantCount,
        priceMin: variantStats.priceMin,
        priceMax: variantStats.priceMax,
        onSale: variantStats.onSale,
        tracked: variantStats.tracked,
        totalStock: variantStats.totalStock,
        variantsOut: variantStats.variantsOut,
        variantsLow: variantStats.variantsLow,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(variantStats, eq(variantStats.productId, products.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(products).where(where),
    // Counts per status for the tabs, with the same search and filters (but any status).
    db
      .select({ status: products.status, n: count() })
      .from(products)
      .where(and(...filters))
      .groupBy(products.status),
  ]);

  const counts = Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, statusRows.find((r) => r.status === s)?.n ?? 0]));
  const items = (await withImages(rows)).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    image: r.image,
    brand: r.brandId === null ? null : { id: r.brandId, name: r.brandName! },
    variantCount: r.variantCount ?? 0,
    priceMin: r.priceMin ?? 0,
    priceMax: r.priceMax ?? 0,
    onSale: r.onSale ?? false,
    totalStock: r.tracked ? (r.totalStock ?? 0) : null,
    variantsOut: r.variantsOut ?? 0,
    variantsLow: r.variantsLow ?? 0,
    updatedAt: r.updatedAt,
  }));

  res.json({
    items,
    total: totalRow?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
    counts: { all: statusRows.reduce((sum, r) => sum + r.n, 0), ...counts },
  });
});

productsRouter.post('/bulk', async (req, res) => {
  const input = productBulkBody.parse(req.body);
  const updated = await bulkUpdate(input);
  await audit(req, { action: `product.bulk.${input.action}`, entityType: 'product', after: input });
  res.json({ updated });
});

productsRouter.patch('/stock', async (req, res) => {
  const input = stockUpdateBody.parse(req.body);
  const { levels, productIds } = await updateStock(input, currentAdmin(req).id);
  await audit(req, { action: 'product.stock', entityType: 'product', entityId: productIds.join(','), after: input });
  res.json({ levels });
});

productsRouter.get('/:id', async (req, res) => {
  res.json(await getProduct(parseId(req.params.id)));
});

productsRouter.post('/', async (req, res) => {
  const input = productBody.parse(req.body);
  const id = await saveProduct(input, currentAdmin(req).id);
  const after = await getProduct(id);
  await audit(req, { action: 'product.create', entityType: 'product', entityId: id, after });
  res.status(201).json(after);
});

productsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = productBody.parse(req.body);
  const before = await getProduct(id);
  await saveProduct(input, currentAdmin(req).id, id);
  const after = await getProduct(id);
  await audit(req, { action: 'product.update', entityType: 'product', entityId: id, before, after });
  res.json(after);
});

productsRouter.post('/:id/duplicate', async (req, res) => {
  const sourceId = parseId(req.params.id);
  const id = await duplicateProduct(sourceId, currentAdmin(req).id);
  const after = await getProduct(id);
  await audit(req, { action: 'product.duplicate', entityType: 'product', entityId: id, after: { sourceId, ...after } });
  res.status(201).json(after);
});

productsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getProduct(id);
  await db.delete(products).where(eq(products.id, id));
  await audit(req, { action: 'product.delete', entityType: 'product', entityId: id, before });
  res.status(204).end();
});

/** Stock locations, for the stock fields in the product form. */
export const stockLocationsRouter = Router();

stockLocationsRouter.get('/', async (_req, res) => {
  const items = await db
    .select({
      id: stockLocations.id,
      name: stockLocations.name,
      isDefault: stockLocations.isDefault,
      isActive: stockLocations.isActive,
    })
    .from(stockLocations)
    .where(eq(stockLocations.isActive, true))
    .orderBy(desc(stockLocations.isDefault), asc(stockLocations.sortOrder), asc(stockLocations.name));
  res.json({ items });
});
