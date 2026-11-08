/**
 * Fills the database with a sample shop: categories, brands, ~260 products with pictures (some with
 * several pictures, options with their own pictures, sales, low stock, sold out), past orders,
 * searches and product requests, so the admin panel and website can be tried with real variety.
 * Safe to run again: anything that already exists (by URL name, or the sample orders by their
 * phone numbers) is left as it is.
 * Run with: npm run db:seed-demo
 */
import { asc, count, eq, like, sql } from 'drizzle-orm';
import { db, pool } from './client.ts';
import { adminUsers, brands, categories, orders, productRequests, products, productVariants, searchQueries, stockLocations } from './schema/index.ts';
import { slugify } from '../lib/slug.ts';
import { storeImage } from '../modules/admin/media/store.ts';
import { createOrder, setStatus } from '../modules/admin/orders/service.ts';
import { productBody } from '../modules/admin/products/schemas.ts';
import { saveProduct } from '../modules/admin/products/service.ts';
import { DEMO_BRANDS, DEMO_CATEGORIES, DEMO_PRODUCTS, type DemoCategory } from './demo/data.ts';
import { MORE_BRANDS, MORE_CATEGORIES, moreProducts, type MoreProduct } from './demo/more.ts';
import { brandPicture, productPicture } from './demo/pictures.ts';

const created = { categories: 0, brands: 0, products: 0, skipped: 0, pictures: 0, orders: 0 };

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
for (const { parent, category } of MORE_CATEGORIES) {
  const parentId = categoryIds.get(parent);
  if (!parentId) throw new Error(`Unknown main category "${parent}"`);
  await addCategory(category, parentId);
}

// ---- Brands ----
const ALL_BRANDS = [...DEMO_BRANDS, ...MORE_BRANDS];
const brandIds = new Map<string, number>();
for (const b of ALL_BRANDS) {
  let [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(sql`lower(${brands.name}) = ${b.name.toLowerCase()}`);
  if (!row) {
    const logo = await storeImage(await brandPicture(b.name, b.color), `${b.name} logo.png`, null);
    [row] = await db
      .insert(brands)
      .values({ name: b.name, slug: slugify(b.name), description: b.description, imageId: logo.id, isFeatured: b.featured ?? false })
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
/** Picture background per colour name (the picture also says the colour). */
const HUE: Record<string, number> = { Blue: 215, Black: 230, Red: 2, Green: 130, Pink: 330, Orange: 28, Yellow: 50, Navy: 228, Maroon: 345, Grey: 200, Purple: 275, Brown: 25 };
const VIEWS = ['Back', 'Close-up', 'In the box'];
const picture = async (name: string, icon: string, hue: number, slug: string, caption?: string) => {
  created.pictures++;
  return storeImage(await productPicture(name, icon, hue, caption), `${slug}${caption ? `-${slugify(caption)}` : ''}.png`, null);
};

const ALL_PRODUCTS: MoreProduct[] = [...DEMO_PRODUCTS, ...moreProducts(ALL_BRANDS.map((b) => b.name))];
const now = Date.now();

for (const [index, d] of ALL_PRODUCTS.entries()) {
  const slug = slugify(d.name);
  const [exists] = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
  if (exists) {
    created.skipped++;
    continue;
  }

  const categoryId = categoryIds.get(d.category);
  if (!categoryId) throw new Error(`Unknown category "${d.category}" for "${d.name}"`);
  const brandCode = ALL_BRANDS.find((b) => b.name === d.brand)?.code ?? 'PT';
  const hue = (index * 47) % 360;

  // Main picture, plus three more views for some products.
  const gallery = [await picture(d.name, d.icon, hue, slug)];
  if (d.morePictures) for (const [v, view] of VIEWS.entries()) gallery.push(await picture(d.name, d.icon, (hue + 60 * (v + 1)) % 360, slug, view));

  const options = d.options ?? [];
  const colourAt = options.findIndex((o) => o.name === 'Colour');
  // Each colour's own picture (shown when the shopper picks it).
  const colourPicture = new Map<string, number>();
  if (d.colourPictures && colourAt >= 0) {
    for (const colour of options[colourAt]!.values) colourPicture.set(colour, (await picture(d.name, d.icon, HUE[colour] ?? hue, slug, colour)).id);
  }
  const saleEndsAt = d.saleDays ? new Date(now + d.saleDays * 864e5).toISOString() : null;

  const variants = combos(options).map((values, i) => {
    const label = values.join(' / ');
    const price = d.variantPrices?.[label] ?? d.price;
    const ratio = price / d.price;
    const stock = Array.isArray(d.stock) ? d.stock[i] : d.stock;
    const suffix = values.length ? `-${values.map((v) => slugify(v).toUpperCase()).join('-')}` : '';
    const salePrice = d.sale !== undefined && d.sale * ratio < price ? round(d.sale * ratio) : null;
    return {
      option1: values[0] ?? null,
      option2: values[1] ?? null,
      option3: values[2] ?? null,
      sku: `${brandCode}-${String(index + 1).padStart(3, '0')}${suffix}`,
      price,
      salePrice,
      saleEndsAt: salePrice ? saleEndsAt : null,
      wholesalePrice: d.wholesale !== undefined ? round(d.wholesale * ratio) : null,
      costPrice: d.cost !== undefined ? round(d.cost * ratio) : null,
      weightGrams: d.weight !== undefined ? round(d.weight * ratio) : null,
      imageId: colourAt >= 0 ? (colourPicture.get(values[colourAt]!) ?? null) : null,
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
    imageIds: gallery.map((g) => g.id),
    options,
    specs: (d.specs ?? []).map(([name, value]) => ({ name, value })),
    variants,
  });
  await saveProduct(input, null);
  created.products++;
  console.log(`Product ${created.products}: ${d.name}`);
}

// ---- Activity: past orders, searches, product requests ----

/** Sample customers (phones 017110000xx, so the sample orders can be found and are added once). */
const PEOPLE = [
  ['Ayesha Siddiqua', 'House 14, Road 6, Dhanmondi', '47', 'dhaka-dhanmondi'],
  ['Rakib Hasan', 'Flat 3B, 22 Kazi Nazrul Islam Avenue, Farmgate', '47', 'dhaka-tejgaon'],
  ['Farhana Akter', 'House 9, Road 11, Uttara Sector 4', '47', 'dhaka-uttara-west'],
  ['Mahmudul Islam', '45/2 Mirpur Road, Kalabagan', '47', 'dhaka-kalabagan'],
  ['Sadia Rahman', 'House 7, Block C, Bashundhara R/A', '47', 'dhaka-vatara'],
  ['Tanvir Ahmed', '12 Agrabad Commercial Area', '8', null],
  ['Nusrat Jahan Mim', 'Holding 33, Zindabazar, Sylhet', '36', null],
  ['Imran Hossain', 'House 2, College Road, Rajshahi', '15', null],
  ['Sumaiya Khan', 'Shibbari Mor, Khulna', '27', null],
  ['Arif Chowdhury', 'Kandirpar, Cumilla', '1', null],
] as const;

const [demoOrders] = await db.select({ n: count() }).from(orders).where(like(orders.phone, '017110000%'));
if (!demoOrders!.n) {
  const [admin] = await db.select({ id: adminUsers.id }).from(adminUsers).orderBy(asc(adminUsers.id)).limit(1);
  // Products to order: one-option products with plenty of stock, so none sells out.
  const { rows: stocked } = await db.execute<{ variant_id: string }>(sql`
    select v.id as variant_id from product_variants v join products p on p.id = v.product_id
    join inventory_levels il on il.variant_id = v.id and il.location_id = ${location.id}
    where p.status = 'active' and il.quantity >= 40 and (select count(*) from product_variants x where x.product_id = p.id) = 1
    order by v.id`);
  const pick = (n: number) => Number(stocked[(n * 37) % stocked.length]!.variant_id);
  const CHANNELS = ['website', 'website', 'website', 'phone', 'facebook', 'whatsapp'] as const;

  for (let i = 0; i < 30 && stocked.length; i++) {
    const [name, address, districtId, areaId] = PEOPLE[i % PEOPLE.length]!;
    const lines = 1 + (i % 4);
    // Popular items come up more often, so "Best sellers" has a clear top.
    const items = Array.from({ length: lines }, (_, l) => ({ variantId: pick(l === 0 ? i % 6 : i * 3 + l), quantity: 1 + ((i + l) % 3) }));
    const unique = [...new Map(items.map((it) => [it.variantId, it])).values()];
    const order = await createOrder(
      {
        type: 'retail',
        channel: CHANNELS[i % CHANNELS.length]!,
        paymentMethod: 'cod',
        customer: { name, phone: `017110000${String(i % PEOPLE.length).padStart(2, '0')}`, email: null },
        districtId,
        areaId,
        address,
        items: unique,
        discount: 0,
        deliveryFee: null,
        customerNote: i % 7 === 0 ? 'Please call before coming.' : null,
        staffNote: null,
      },
      null,
    );
    // Most are delivered; some still on the way; a few new or cancelled.
    const flow: ('confirmed' | 'shipped' | 'delivered' | 'cancelled')[] =
      i % 10 === 9 ? ['cancelled'] : i < 4 ? [] : i < 7 ? ['confirmed'] : i < 9 ? ['confirmed', 'shipped'] : ['confirmed', 'shipped', 'delivered'];
    if (admin) {
      for (const status of flow) {
        await setStatus(
          order.id,
          { status, note: status === 'cancelled' ? 'Customer changed their mind' : null, courier: status === 'shipped' ? (i % 2 ? 'Steadfast' : 'Pathao') : undefined, trackingCode: status === 'shipped' ? `SF${100000 + i * 731}` : undefined, collectDue: status === 'delivered' },
          admin.id,
        );
      }
    }
    // Spread over the last 60 days (newest first in the list).
    await db.update(orders).set({ createdAt: new Date(now - (30 - i) * 2 * 864e5 + i * 3_600_000) }).where(eq(orders.id, order.id));
    created.orders++;
  }
  console.log(`Orders: ${created.orders}`);
}

const [searches] = await db.select({ n: count() }).from(searchQueries);
if (!searches!.n) {
  // What shoppers typed: [words, products found, fixed to, times].
  const TYPED: [string, number, string | null, number][] = [
    ['pen', 40, null, 14], ['khata', 9, null, 11], ['gel pen', 8, null, 9], ['pencil', 24, null, 8], ['notebook', 12, null, 7],
    ['geometry box', 6, null, 6], ['colour pencil', 7, null, 6], ['a4 paper', 8, null, 5], ['calculator', 6, null, 5], ['penicl', 24, 'pencil', 4],
    ['rong pencil', 7, null, 4], ['school bag', 5, null, 4], ['highliter', 6, 'highlighter', 3], ['stapler', 4, null, 3], ['casio', 3, null, 3],
    ['pelican', 4, 'pelikan', 2], ['glitter', 3, null, 2], ['sticky note', 4, null, 2], ['fountain pen', 9, null, 2],
    ['scientific calculator 991', 1, null, 2], ['quran stand', 0, null, 3], ['printer ink', 0, null, 3], ['laminating sheet', 0, null, 2],
    ['abacus', 0, null, 2], ['globe', 0, null, 1], ['calligraphy nib', 1, null, 1],
  ];
  const rows = TYPED.flatMap(([query, results, correctedTo, times], i) =>
    Array.from({ length: times }, (_, t) => ({ query, results, correctedTo, createdAt: new Date(now - ((i * 5 + t * 7) % 28) * 864e5 - t * 3_600_000) })),
  );
  await db.insert(searchQueries).values(rows);
  console.log(`Searches: ${rows.length}`);
}

const [requests] = await db.select({ n: count() }).from(productRequests);
if (!requests!.n) {
  await db.insert(productRequests).values([
    { name: 'Sharmin Akter', phone: '01711000101', details: 'Laminating sheets A4, about 100', query: 'laminating sheet' },
    { name: 'Habib Rahman', phone: '01711000102', details: 'HP 680 black printer ink cartridge', query: 'printer ink' },
    { name: 'Lamia Islam', phone: '01711000103', details: 'Wooden Quran stand (rehal), medium size', query: 'quran stand', status: 'done', staffNote: 'Told her we will stock it from next month', handledAt: new Date(now - 2 * 864e5) },
  ]);
  console.log('Product requests: 3');
}

console.log(
  `Done. Added ${created.categories} categories, ${created.brands} brands, ${created.products} products (${created.pictures} pictures), ${created.orders} orders` +
    (created.skipped ? `; ${created.skipped} products were already there.` : '.'),
);
await pool.end();
