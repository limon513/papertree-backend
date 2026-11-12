import type { ProductStatus } from '../../../db/schema/index.ts';

/** One variant as read from the file. Empty cells are null. */
export interface ImportVariant {
  /** Line in the file, for messages. */
  line: number;
  /** Values for the product's options, in the same order. */
  values: (string | null)[];
  sku: string | null;
  price: number | null;
  salePrice: number | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  wholesalePrice: number | null;
  costPrice: number | null;
  weightGrams: number | null;
  /** null: stock is not tracked. */
  stock: number | null;
  lowStock: number | null;
  allowBackorder: boolean;
  image: string | null;
}

/** One product as read from the file (our template or a WooCommerce export). */
export interface ImportProduct {
  lines: number[];
  name: string;
  status: ProductStatus | null;
  shortDescription: string | null;
  description: string | null;
  brand: string | null;
  /** Category paths, e.g. [["Paper", "Art Paper"], ["Gifts"]]. */
  categories: string[][];
  tags: string[];
  /** Image links in order; the first is the main image. */
  images: string[];
  specs: { name: string; value: string }[];
  options: { name: string; values: string[] }[];
  variants: ImportVariant[];
  seoTitle: string | null;
  seoDescription: string | null;
  /** The address to keep (old site copy): /product/<slug>/ stays the same, so old links keep working. */
  slug?: string | null;
  /** Problems found while reading. A product with problems is not imported. */
  problems: string[];
}
