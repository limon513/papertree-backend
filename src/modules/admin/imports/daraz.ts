import type { ProductStatus } from '../../../db/schema/index.ts';
import { htmlToText } from '../../../lib/html.ts';
import { date, textToHtml, type Table } from './csv.ts';
import type { ImportProduct, ImportVariant } from './types.ts';

/**
 * Reads Daraz Seller Center exports (Products > Manage Products > Export):
 * - "basic": name, pictures, description (one line per product)
 * - "price & stock": price, special price, quantity, SKUs (one line per SKU / variant)
 * Either file works alone; together they are matched by Product ID.
 *
 * The Seller SKU becomes our SKU, so a later price & stock export can update the shop
 * ("Update price and stock"), and the product can be linked to Daraz again.
 */

type Row = Record<string, string>;

// Headers are normalized by toTable: "*Product Name(English)" -> "product name english".
export const isDarazBasic = (headers: string[]) => headers.includes('product id') && headers.includes('product images1');
export const isDarazPriceStock = (headers: string[]) =>
  headers.includes('product id') && headers.includes('sellersku') && headers.includes('quantity');

const get = (row: Row, name: string) => row[name]?.trim() ?? '';

function money(text: string) {
  if (!text) return null;
  const n = Number(text.replace(/[,\s৳]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Daraz uses a picture link where no text was written. */
const isOnlyLinks = (text: string) => /^(\s*https?:\/\/\S+\s*)+$/i.test(text);

/** "Color family:Black;Size:M" -> [["Color family","Black"],["Size","M"]]. "Not Specified" -> []. */
function variations(text: string): [string, string][] {
  if (!text || /^not specified$/i.test(text)) return [];
  return text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      return at > 0 ? ([part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string]) : ['Variation', part];
    });
}

function statusOf(text: string): ProductStatus | null {
  const t = text.toLowerCase();
  if (t === 'active') return 'active';
  if (t === 'inactive') return 'draft';
  return null;
}

export function readDaraz(basic: Table | null, priceStock: Table | null): ImportProduct[] {
  const products = new Map<string, ImportProduct>();
  const order: string[] = [];

  const productFor = (id: string, name: string, line: number) => {
    let p = products.get(id);
    if (!p) {
      p = {
        lines: [line],
        name,
        status: null,
        shortDescription: null,
        description: null,
        brand: null,
        categories: [],
        tags: [],
        images: [],
        specs: [],
        options: [],
        variants: [],
        seoTitle: null,
        seoDescription: null,
        problems: [],
      };
      products.set(id, p);
      order.push(id);
    }
    return p;
  };

  for (const { row, line } of basic?.rows ?? []) {
    const id = get(row, 'product id') || `line-${line}`;
    const name = get(row, 'product name english');
    if (!name) continue;
    const p = productFor(id, name, line);
    p.images = Array.from({ length: 8 }, (_, i) => get(row, `product images${i + 1}`)).filter((s) => /^https?:\/\//i.test(s));
    const description = get(row, 'main description');
    if (description && !isOnlyLinks(description)) p.description = textToHtml(description);
    const highlights = get(row, 'highlights');
    if (highlights && !isOnlyLinks(highlights)) p.shortDescription = htmlToText(highlights).slice(0, 1000) || null;
  }

  // Price & stock lines: one per SKU. Lines from the basic file without one get no price.
  for (const { row, line } of priceStock?.rows ?? []) {
    const id = get(row, 'product id') || `line-${line}`;
    const name = get(row, 'product name english');
    if (!name) continue;
    const status = get(row, 'status').toLowerCase();
    if (status === 'deleted') continue;
    const p = productFor(id, name, line);
    const where = basic ? `Price file line ${line}` : `Line ${line}`;

    const pairs = variations(get(row, 'variations combo'));
    for (const [optionName, value] of pairs) {
      let option = p.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
      if (!option) p.options.push((option = { name: optionName, values: [] }));
      if (!option.values.some((v) => v.toLowerCase() === value.toLowerCase())) option.values.push(value);
    }

    const num = (field: string, label: string) => {
      const value = money(get(row, field));
      if (value === undefined) {
        p.problems.push(`${where}: "${get(row, field)}" is not a valid ${label}`);
        return null;
      }
      return value;
    };
    const quantity = num('quantity', 'quantity');
    // Some sellers typed the product name as Seller SKU; then Daraz's own Shop SKU is used.
    const sellerSku = get(row, 'sellersku');
    const sku = (sellerSku && sellerSku.length <= 64 ? sellerSku : get(row, 'shop sku')) || null;
    const variant: ImportVariant = {
      line,
      values: pairs.map(([, v]) => v),
      sku: sku?.slice(0, 64) ?? null,
      price: num('price', 'price'),
      salePrice: num('specialprice', 'special price'),
      saleStartsAt: date(get(row, 'specialprice start')),
      saleEndsAt: date(get(row, 'specialprice end')),
      wholesalePrice: null,
      costPrice: null,
      weightGrams: null,
      stock: quantity === null ? null : Math.round(quantity),
      lowStock: null,
      allowBackorder: false,
      image: null,
    };
    // A special price that is not lower than the price is not a sale.
    if (variant.salePrice !== null && variant.price !== null && variant.salePrice >= variant.price) {
      variant.salePrice = null;
      variant.saleStartsAt = null;
      variant.saleEndsAt = null;
    }
    p.variants.push(variant);
    // Active if any SKU is active on Daraz.
    const s = statusOf(status);
    if (s && p.status !== 'active') p.status = s;
  }

  return order.map((id) => {
    const p = products.get(id)!;
    if (!p.variants.length) {
      p.problems.push(
        priceStock
          ? 'Not in the price & stock file, so it has no price'
          : 'No price: upload the "price & stock" export together with this file',
      );
    }
    // Every variant needs a value for every option.
    if (p.options.length && p.variants.some((v) => v.values.length !== p.options.length)) {
      p.problems.push('The variations of this product could not be read');
    }
    return p;
  });
}

/** Daraz exports have no brand column: use our brand whose name starts the product name ("DOMS Colour Pencil"). */
export function guessBrands(products: ImportProduct[], brandNames: string[]) {
  const sorted = [...brandNames].sort((a, b) => b.length - a.length);
  for (const p of products) {
    if (p.brand) continue;
    const name = p.name.toLowerCase();
    const match = sorted.find((b) => name.startsWith(b.toLowerCase()) && /^($|[^\p{L}\p{N}])/u.test(name.slice(b.length)));
    if (match) p.brand = match;
  }
}
