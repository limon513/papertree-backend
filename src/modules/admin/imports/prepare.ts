import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { brands, categories, products, productVariants, type ImportAction, type ImportOptions } from '../../../db/schema/index.ts';
import { productBody } from '../products/schemas.ts';
import type { ImportProduct } from './types.ts';

export interface PreparedRow {
  product: ImportProduct;
  action: ImportAction;
  message: string | null;
}

/** "paper > art paper" for every category, to match the file's category paths. */
export async function categoryPathIndex() {
  const rows = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: number): string => {
    const c = byId.get(id)!;
    return c.parentId === null ? c.name.toLowerCase() : `${pathOf(c.parentId)} > ${c.name.toLowerCase()}`;
  };
  return new Map(rows.map((r) => [pathOf(r.id), r.id]));
}

export const pathKey = (path: string[]) => path.map((s) => s.toLowerCase()).join(' > ');

/** The product in the shape the product form uses, to reuse its checks. Images and links are filled in later. */
export function toProductBody(p: ImportProduct, status: ImportProduct['status']) {
  return {
    name: p.name,
    // The old address, kept (old site copy). Otherwise one is made from the name.
    ...(p.slug ? { slug: p.slug } : {}),
    status: status ?? 'draft',
    shortDescription: p.shortDescription?.slice(0, 1000) ?? null,
    description: p.description,
    tags: p.tags.map((t) => t.slice(0, 50)).slice(0, 30),
    options: p.options,
    specs: p.specs.slice(0, 50),
    seoTitle: p.seoTitle?.slice(0, 200) ?? null,
    seoDescription: p.seoDescription?.slice(0, 500) ?? null,
    variants: p.variants.map((v) => ({
      option1: v.values[0] ?? null,
      option2: v.values[1] ?? null,
      option3: v.values[2] ?? null,
      sku: v.sku,
      price: v.price,
      salePrice: v.salePrice,
      saleStartsAt: v.saleStartsAt,
      saleEndsAt: v.saleEndsAt,
      wholesalePrice: v.wholesalePrice,
      costPrice: v.costPrice,
      weightGrams: v.weightGrams,
      trackStock: v.stock !== null,
      allowBackorder: v.allowBackorder,
      lowStockThreshold: v.lowStock,
    })),
  };
}

/** Decides for every product: create, update, skip, or error (with the reason). Nothing is saved. */
export async function prepareImport(items: ImportProduct[], options: ImportOptions): Promise<PreparedRow[]> {
  const skus = [...new Set(items.flatMap((p) => p.variants.flatMap((v) => (v.sku ? [v.sku.toLowerCase()] : []))))];
  const slugs = [...new Set(items.flatMap((p) => (p.slug ? [p.slug] : [])))];
  const [existingSkus, categoryIndex, brandRows, slugRows] = await Promise.all([
    skus.length
      ? db
          .select({ sku: productVariants.sku, productId: products.id, productName: products.name })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(sql`lower(${productVariants.sku})`, skus))
      : [],
    categoryPathIndex(),
    db.select({ name: brands.name }).from(brands),
    slugs.length ? db.select({ slug: products.slug, name: products.name }).from(products).where(inArray(products.slug, slugs)) : [],
  ]);
  const slugOwner = new Map(slugRows.map((r) => [r.slug, r.name]));
  const skuOwner = new Map(existingSkus.map((r) => [r.sku!.toLowerCase(), r]));
  const brandNames = new Set(brandRows.map((b) => b.name.toLowerCase()));

  // The same SKU on two products in one file can't work.
  const skuCount = new Map<string, number>();
  for (const p of items) {
    for (const sku of new Set(p.variants.flatMap((v) => (v.sku ? [v.sku.toLowerCase()] : [])))) {
      skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
    }
  }

  return items.map((p): PreparedRow => {
    if (p.problems.length) return { product: p, action: 'error', message: p.problems.slice(0, 5).join('\n') };
    // Old site copy: already here at the same address (copied before): nothing to do.
    if (p.slug && slugOwner.has(p.slug)) return { product: p, action: 'skip', message: `Already in the shop at /product/${p.slug}/ ("${slugOwner.get(p.slug)}")` };

    const dupes = p.variants.filter((v) => v.sku && (skuCount.get(v.sku.toLowerCase()) ?? 0) > 1);
    if (dupes.length) {
      return { product: p, action: 'error', message: `SKU ${dupes[0]!.sku} is used by more than one product in the file` };
    }

    const found = p.variants.flatMap((v) => (v.sku && skuOwner.has(v.sku.toLowerCase()) ? [skuOwner.get(v.sku.toLowerCase())!] : []));
    if (found.length) {
      const owner = found[0]!;
      if (options.existing === 'skip') {
        return { product: p, action: 'skip', message: `Already in the shop as "${owner.productName}" (SKU ${owner.sku})` };
      }
      const missing = p.variants.length - found.length;
      return {
        product: p,
        action: 'update',
        message:
          `Updates price and stock of ${found.length} variant${found.length === 1 ? '' : 's'} of "${owner.productName}"` +
          (missing ? `. ${missing} line${missing === 1 ? ' has a' : 's have'} a new SKU and will be ignored.` : ''),
      };
    }

    // A new product: run the same checks as the product form.
    const problems: string[] = [];
    p.variants.forEach((v) => {
      if (v.price === null) problems.push(`Line ${v.line}: the price is missing`);
    });
    const parsed = productBody.safeParse(toProductBody(p, p.status));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [first, index] = issue.path;
        const line = first === 'variants' && typeof index === 'number' ? p.variants[index]?.line : undefined;
        const message = `${line ? `Line ${line}: ` : ''}${issue.message}`;
        if (!problems.includes(message) && !(issue.path.at(-1) === 'price' && message.includes('Enter the price'))) {
          problems.push(message);
        }
      }
    }

    const newCategories = p.categories.filter((path) => !categoryIndex.has(pathKey(path)));
    const newBrand = p.brand && !brandNames.has(p.brand.toLowerCase()) ? p.brand : null;
    if (!options.createMissing) {
      if (newCategories.length) problems.push(`Category not found: ${newCategories.map((c) => c.join(' > ')).join(', ')}`);
      if (newBrand) problems.push(`Brand not found: ${newBrand}`);
    }
    if (p.categories.some((path) => path.length > 3)) problems.push('Categories can be at most 3 levels deep');
    if (problems.length) return { product: p, action: 'error', message: problems.slice(0, 5).join('\n') };

    const notes = [
      newCategories.length ? `New categor${newCategories.length === 1 ? 'y' : 'ies'}: ${newCategories.map((c) => c.join(' > ')).join(', ')}` : null,
      newBrand ? `New brand: ${newBrand}` : null,
    ].filter(Boolean);
    return { product: p, action: 'create', message: notes.length ? notes.join('. ') : null };
  });
}
