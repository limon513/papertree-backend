import { and, asc, eq, inArray, like, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import {
  brands,
  categories,
  inventoryLevels,
  inventoryMovements,
  media,
  productCategories,
  productImages,
  products,
  productVariants,
  stockLocations,
} from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { cleanHtml } from '../../../lib/html.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { mediaView, withImages } from '../media/view.ts';
import type { ProductInput } from './schemas.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The full product as the edit form needs it. */
export async function getProduct(id: number) {
  // All in parallel: each query is a round trip to the database.
  const [[product], cats, images, variants, levels] = await Promise.all([
    db.select().from(products).where(eq(products.id, id)).limit(1),
    db.select().from(productCategories).where(eq(productCategories.productId, id)),
    db
      .select({ media })
      .from(productImages)
      .innerJoin(media, eq(media.id, productImages.mediaId))
      .where(eq(productImages.productId, id))
      .orderBy(asc(productImages.position)),
    db.select().from(productVariants).where(eq(productVariants.productId, id)).orderBy(asc(productVariants.position)),
    db
      .select({ variantId: inventoryLevels.variantId, locationId: inventoryLevels.locationId, quantity: inventoryLevels.quantity })
      .from(inventoryLevels)
      .innerJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
      .where(eq(productVariants.productId, id)),
  ]);
  if (!product) throw notFound('Product not found');

  const primary = cats.find((c) => c.isPrimary) ?? cats[0];
  return {
    ...product,
    categoryIds: cats.map((c) => c.categoryId),
    primaryCategoryId: primary?.categoryId ?? null,
    images: images.map((r) => mediaView(r.media)),
    variants: (await withImages(variants)).map((v) => ({
      ...v,
      stock: levels.filter((l) => l.variantId === v.id).map((l) => ({ locationId: l.locationId, quantity: l.quantity })),
    })),
  };
}

export type ProductDetail = Awaited<ReturnType<typeof getProduct>>;

/** Checks everything the form points to: brand, categories, images, locations, variant ids, SKUs, slug. */
async function checkInput(input: ProductInput, productId?: number) {
  const [brand] = input.brandId
    ? await db.select({ id: brands.id }).from(brands).where(eq(brands.id, input.brandId))
    : [{ id: 0 }];
  if (!brand) throw badRequest('Choose a valid brand', { brandId: 'This brand no longer exists' });

  if (input.categoryIds.length) {
    const found = await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, input.categoryIds));
    if (found.length !== input.categoryIds.length) {
      throw badRequest('A chosen category no longer exists', { categoryIds: 'A chosen category no longer exists' });
    }
  }

  const mediaIds = [...new Set([...input.imageIds, ...input.variants.flatMap((v) => (v.imageId ? [v.imageId] : []))])];
  if (mediaIds.length) {
    const found = await db.select({ id: media.id }).from(media).where(inArray(media.id, mediaIds));
    if (found.length !== mediaIds.length) {
      throw badRequest('An image was not found. Upload it again.', { imageIds: 'An image was not found. Upload it again.' });
    }
  }

  const locationIds = [...new Set(input.variants.flatMap((v) => v.stock.map((s) => s.locationId)))];
  if (locationIds.length) {
    const found = await db.select({ id: stockLocations.id }).from(stockLocations).where(inArray(stockLocations.id, locationIds));
    if (found.length !== locationIds.length) throw badRequest('A stock location no longer exists. Reload the page.');
  }

  if (productId !== undefined) {
    const existing = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
    input.variants.forEach((v, i) => {
      if (v.id !== undefined && !existing.some((e) => e.id === v.id)) {
        const message = 'This variant no longer exists. Reload the page.';
        throw badRequest(message, { [`variants.${i}`]: message });
      }
    });
  }

  // SKUs must be unique across all products.
  const skus = input.variants.flatMap((v, i) => (v.sku ? [{ sku: v.sku.toLowerCase(), i }] : []));
  if (skus.length) {
    const taken = await db
      .select({ sku: productVariants.sku, productName: products.name })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          inArray(sql`lower(${productVariants.sku})`, skus.map((s) => s.sku)),
          productId === undefined ? undefined : ne(productVariants.productId, productId),
        ),
      );
    for (const t of taken) {
      const hit = skus.find((s) => s.sku === t.sku?.toLowerCase())!;
      const message = `This SKU is already used by "${t.productName}"`;
      throw conflict(message, { [`variants.${hit.i}.sku`]: message });
    }
  }
}

async function pickSlug(given: string | undefined, name: string, productId?: number) {
  const base = given || slugify(name);
  if (!base) throw badRequest('Enter a URL name', { slug: 'Enter a URL name using letters or numbers' });

  const similar = await db
    .select({ id: products.id, name: products.name, slug: products.slug })
    .from(products)
    .where(or(eq(products.slug, base), like(products.slug, `${base}-%`)));
  const others = similar.filter((p) => p.id !== productId);

  if (given) {
    const owner = others.find((p) => p.slug === given);
    if (owner) {
      const message = `This URL name is already used by "${owner.name}"`;
      throw conflict(message, { slug: message });
    }
    return given;
  }
  return freeSlug(base, new Set(others.map((p) => p.slug)));
}

/** Sets stock for one variant at one location and records the change. */
async function setStock(
  tx: Tx,
  variantId: number,
  locationId: number,
  entry: { quantity: number; baseQuantity?: number },
  reason: 'initial' | 'adjustment',
  adminUserId: number | null,
) {
  const [current] = await tx
    .select({ quantity: inventoryLevels.quantity })
    .from(inventoryLevels)
    .where(and(eq(inventoryLevels.variantId, variantId), eq(inventoryLevels.locationId, locationId)))
    .for('update');

  const now = current?.quantity ?? 0;
  // Apply only the change the user made, on top of whatever the stock is now.
  const target = entry.baseQuantity !== undefined ? now + (entry.quantity - entry.baseQuantity) : entry.quantity;
  const change = target - now;
  if (change === 0 && current) return;

  await tx
    .insert(inventoryLevels)
    .values({ variantId, locationId, quantity: target })
    .onConflictDoUpdate({ target: [inventoryLevels.variantId, inventoryLevels.locationId], set: { quantity: target } });

  if (change !== 0) {
    await tx.insert(inventoryMovements).values({ variantId, locationId, change, quantityAfter: target, reason, adminUserId });
  }
}

/** Creates (no productId) or saves a product from the full form. Returns the product id. */
export async function saveProduct(input: ProductInput, adminUserId: number | null, productId?: number) {
  await checkInput(input, productId);
  const slug = input.slug === undefined && productId !== undefined ? undefined : await pickSlug(input.slug, input.name, productId);

  const fields = {
    name: input.name,
    status: input.status,
    shortDescription: input.shortDescription,
    description: input.description === null ? null : cleanHtml(input.description),
    brandId: input.brandId,
    tags: input.tags,
    options: input.options,
    specs: input.specs,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
  };

  return db.transaction(async (tx) => {
    let id: number;
    if (productId === undefined) {
      const [row] = await tx
        .insert(products)
        .values({
          ...fields,
          slug: slug!,
          createdBy: adminUserId,
          publishedAt: input.status === 'active' ? new Date() : null,
        })
        .returning({ id: products.id });
      id = row!.id;
    } else {
      id = productId;
      await tx
        .update(products)
        .set({
          ...fields,
          slug,
          // Remember when it first went live.
          publishedAt: input.status === 'active' ? sql`coalesce(${products.publishedAt}, now())` : undefined,
        })
        .where(eq(products.id, id));
    }

    // Categories: replace. The main one is marked.
    await tx.delete(productCategories).where(eq(productCategories.productId, id));
    if (input.categoryIds.length) {
      const primary = input.primaryCategoryId ?? input.categoryIds[0];
      await tx
        .insert(productCategories)
        .values(input.categoryIds.map((categoryId) => ({ productId: id, categoryId, isPrimary: categoryId === primary })));
    }

    // Gallery: replace, in the given order.
    await tx.delete(productImages).where(eq(productImages.productId, id));
    if (input.imageIds.length) {
      await tx.insert(productImages).values(input.imageIds.map((mediaId, position) => ({ productId: id, mediaId, position })));
    }

    // Variants: remove the ones no longer in the form, then update or add the rest.
    const keepIds = input.variants.flatMap((v) => (v.id ? [v.id] : []));
    await tx
      .delete(productVariants)
      .where(and(eq(productVariants.productId, id), keepIds.length ? notInArray(productVariants.id, keepIds) : undefined));
    // Clear SKUs first so two variants can swap SKUs without a clash.
    if (keepIds.length) await tx.update(productVariants).set({ sku: null }).where(inArray(productVariants.id, keepIds));

    // "red" in a variant becomes "Red" when the option value is written that way.
    const canonical = (n: number, value: string | null) =>
      value ? (input.options[n]?.values.find((ov) => ov.toLowerCase() === value.toLowerCase()) ?? value) : null;

    for (const [position, v] of input.variants.entries()) {
      const values = {
        option1: canonical(0, v.option1),
        option2: canonical(1, v.option2),
        option3: canonical(2, v.option3),
        sku: v.sku,
        barcode: v.barcode,
        price: v.price,
        salePrice: v.salePrice,
        saleStartsAt: v.saleStartsAt ? new Date(v.saleStartsAt) : null,
        saleEndsAt: v.saleEndsAt ? new Date(v.saleEndsAt) : null,
        wholesalePrice: v.wholesalePrice,
        costPrice: v.costPrice,
        weightGrams: v.weightGrams,
        imageId: v.imageId,
        trackStock: v.trackStock,
        allowBackorder: v.allowBackorder,
        lowStockThreshold: v.lowStockThreshold,
        position,
      };

      let variantId: number;
      if (v.id) {
        variantId = v.id;
        await tx.update(productVariants).set(values).where(eq(productVariants.id, variantId));
      } else {
        const [row] = await tx
          .insert(productVariants)
          .values({ ...values, productId: id })
          .returning({ id: productVariants.id });
        variantId = row!.id;
      }

      for (const s of v.stock) {
        await setStock(tx, variantId, s.locationId, s, v.id ? 'adjustment' : 'initial', adminUserId);
      }
    }

    return id;
  });
}

/** A draft copy: same details, no SKUs, no stock. */
export async function duplicateProduct(id: number, adminUserId: number | null) {
  const p = await getProduct(id);
  return saveProduct(
    {
      name: `${p.name} (copy)`.slice(0, 200),
      slug: undefined,
      status: 'draft',
      shortDescription: p.shortDescription,
      description: p.description,
      brandId: p.brandId,
      categoryIds: p.categoryIds,
      primaryCategoryId: p.primaryCategoryId,
      tags: p.tags,
      imageIds: p.images.map((i) => i.id),
      options: p.options,
      specs: p.specs,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      variants: p.variants.map((v) => ({
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        sku: null,
        barcode: null,
        price: v.price,
        salePrice: v.salePrice,
        saleStartsAt: v.saleStartsAt?.toISOString() ?? null,
        saleEndsAt: v.saleEndsAt?.toISOString() ?? null,
        wholesalePrice: v.wholesalePrice,
        costPrice: v.costPrice,
        weightGrams: v.weightGrams,
        imageId: v.imageId,
        trackStock: v.trackStock,
        allowBackorder: v.allowBackorder,
        lowStockThreshold: v.lowStockThreshold,
        stock: [],
      })),
    },
    adminUserId,
  );
}
