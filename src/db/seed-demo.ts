/**
 * Fills the database with a sample shop (categories, brands, products with pictures).
 * Safe to run again: anything that already exists (by URL name) is left as it is.
 * Run with: npm run db:seed-demo
 */
import { asc, eq, sql } from 'drizzle-orm';
import { db, pool } from './client.ts';
import { brands, categories, products, stockLocations } from './schema/index.ts';
import { slugify } from '../lib/slug.ts';
import { storeImage } from '../modules/admin/media/store.ts';
import { productBody } from '../modules/admin/products/schemas.ts';
import { saveProduct } from '../modules/admin/products/service.ts';
import { DEMO_BRANDS, DEMO_CATEGORIES, DEMO_PRODUCTS, type DemoCategory } from './demo/data.ts';
import { brandPicture, productPicture } from './demo/pictures.ts';

const created = { categories: 0, brands: 0, products: 0, skipped: 0 };

// ---- Categories ----
const categoryIds = new Map<string, number>();

async function addCategory(c: DemoCategory, parentId: number | null) {
  const slug = slugify(c.name);
  let [row] = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug));
  if (!row) {
    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${categories.sortOrder}) + 1, 0)`.mapWith(Number) })
      .from(categories)
      .where(parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, parentId));
    [row] = await db
      .insert(categories)
      .values({ name: c.name, slug, parentId, icon: c.icon, description: c.description ?? null, sortOrder: next })
      .returning({ id: categories.id });
    created.categories++;
  }
  categoryIds.set(c.name, row!.id);
  for (const child of c.children ?? []) await addCategory(child, row!.id);
}

for (const c of DEMO_CATEGORIES) await addCategory(c, null);

// ---- Brands ----
const brandIds = new Map<string, number>();
for (const b of DEMO_BRANDS) {
  let [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(sql`lower(${brands.name}) = ${b.name.toLowerCase()}`);
  if (!row) {
    const logo = await storeImage(await brandPicture(b.name, b.color), `${b.name} logo.png`, null);
    [row] = await db
      .insert(brands)
      .values({
        name: b.name,
        slug: slugify(b.name),
        description: b.description,
        imageId: logo.id,
        isFeatured: b.featured ?? false,
      })
      .returning({ id: brands.id });
    created.brands++;
    console.log(`Brand: ${b.name}`);
  }
  brandIds.set(b.name, row!.id);
}

// ---- Products ----
const [location] = await db
  .select({ id: stockLocations.id })
  .from(stockLocations)
  .orderBy(sql`${stockLocations.isDefault} desc`, asc(stockLocations.id))
  .limit(1);
if (!location) throw new Error('No stock location. Run the migrations first.');

const combos = (options: { values: string[] }[]) =>
  options.reduce<string[][]>((acc, o) => acc.flatMap((c) => o.values.map((v) => [...c, v])), [[]]);
const round = (n: number) => Math.round(n);

for (const [index, d] of DEMO_PRODUCTS.entries()) {
  const slug = slugify(d.name);
  const [exists] = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
  if (exists) {
    created.skipped++;
    continue;
  }

  const categoryId = categoryIds.get(d.category);
  if (!categoryId) throw new Error(`Unknown category "${d.category}" for "${d.name}"`);
  const brandCode = DEMO_BRANDS.find((b) => b.name === d.brand)?.code ?? 'PT';

  const picture = await storeImage(await productPicture(d.name, d.icon, (index * 47) % 360), `${slug}.png`, null);

  const options = d.options ?? [];
  const variants = combos(options).map((values, i) => {
    const label = values.join(' / ');
    const price = d.variantPrices?.[label] ?? d.price;
    const ratio = price / d.price;
    const stock = Array.isArray(d.stock) ? d.stock[i] : d.stock;
    const suffix = values.length ? `-${values.map((v) => slugify(v).toUpperCase()).join('-')}` : '';
    return {
      option1: values[0] ?? null,
      option2: values[1] ?? null,
      option3: values[2] ?? null,
      sku: `${brandCode}-${String(index + 1).padStart(3, '0')}${suffix}`,
      price,
      salePrice: d.sale !== undefined && d.sale * ratio < price ? round(d.sale * ratio) : null,
      wholesalePrice: d.wholesale !== undefined ? round(d.wholesale * ratio) : null,
      costPrice: d.cost !== undefined ? round(d.cost * ratio) : null,
      weightGrams: d.weight !== undefined ? round(d.weight * ratio) : null,
      trackStock: d.stock !== undefined,
      lowStockThreshold: d.lowStock ?? null,
      stock: stock === undefined ? [] : [{ locationId: location.id, quantity: stock }],
    };
  });

  const input = productBody.parse({
    name: d.name,
    status: d.status ?? 'active',
    shortDescription: d.short,
    description: d.description,
    brandId: d.brand ? brandIds.get(d.brand) : null,
    categoryIds: [categoryId],
    tags: d.tags ?? [],
    imageIds: [picture.id],
    options,
    specs: (d.specs ?? []).map(([name, value]) => ({ name, value })),
    variants,
  });
  await saveProduct(input, null);
  created.products++;
  console.log(`Product ${created.products}: ${d.name}`);
}

console.log(
  `Done. Added ${created.categories} categories, ${created.brands} brands, ${created.products} products` +
    (created.skipped ? ` (${created.skipped} products were already there).` : '.'),
);
await pool.end();
