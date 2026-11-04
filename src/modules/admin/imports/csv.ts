import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { ImportFormat, ProductStatus } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import type { ImportProduct, ImportVariant } from './types.ts';

/**
 * Reads a product CSV: our own template, or WooCommerce's "Export products" file.
 * Every product becomes one ImportProduct; problems are collected, not thrown.
 */

export const MAX_PRODUCTS = 5000;

type Row = Record<string, string>;

/** "Regular price" -> "regular price", "Weight (kg)" -> "weight kg". */
const normalize = (header: string) =>
  header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** First non-empty value among the given column names. */
const get = (row: Row, ...names: string[]) => {
  for (const name of names) {
    const value = row[name]?.trim();
    if (value) return value;
  }
  return '';
};

/** "৳1,250.50" -> 1250.5. Empty -> null. Not a number -> undefined. */
function money(text: string): number | null | undefined {
  const cleaned = text.replace(/[৳,\s]|tk\.?|bdt/gi, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function wholeNumber(text: string): number | null | undefined {
  const n = money(text);
  if (n === null || n === undefined) return n;
  return Number.isInteger(n) ? n : undefined;
}

/** Splits on commas that are not escaped as "\," (WooCommerce escapes commas in names). */
const splitList = (text: string) =>
  text
    .split(/(?<!\\),/)
    .map((part) => part.replace(/\\,/g, ',').trim())
    .filter(Boolean);

/** Image lists may be separated by commas, "|" or new lines. */
const splitImages = (text: string) =>
  text
    .split(/[,|\n]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));

const categoryPaths = (text: string) =>
  splitList(text)
    .map((path) =>
      path
        .split('>')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((path) => path.length > 0);

/** Plain text (or WooCommerce text with line breaks) to simple HTML. */
export function textToHtml(text: string) {
  const t = text.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
  if (!t) return null;
  if (/<(p|ul|ol|h[1-6]|table|div|br)\b/i.test(t)) return t;
  return t
    .split(/\n{2,}/)
    .map((para) => `<p>${para.trim().replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * "2026-12-01 00:00:00" or "2026-12-01" -> ISO date, or null.
 * Dates without a time zone are Bangladesh time, whatever time zone the server runs in.
 */
export function date(text: string) {
  if (!text) return null;
  let t = text.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += '+06:00';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readStatus(text: string): ProductStatus | null {
  const t = text.toLowerCase();
  if (!t) return null;
  if (['1', 'active', 'published', 'publish', 'yes'].includes(t)) return 'active';
  if (['archived', 'archive'].includes(t)) return 'archived';
  return 'draft';
}

const emptyProduct = (name: string, line: number): ImportProduct => ({
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
});

/** Reads the price, stock and other variant fields shared by both formats. */
function readVariant(
  row: Row,
  line: number,
  values: (string | null)[],
  problems: string[],
  cols: {
    price: string[];
    sale: string[];
    wholesale: string[];
    cost: string[];
    stock: string[];
    weightGrams?: string[];
    weightKg?: string[];
    low: string[];
    image: string[];
  },
): ImportVariant {
  const num = (names: string[], label: string, read = money) => {
    const text = get(row, ...names);
    const value = read(text);
    if (value === undefined) {
      problems.push(`Line ${line}: "${text}" is not a valid ${label}`);
      return null;
    }
    return value;
  };
  const kg = cols.weightKg ? num(cols.weightKg, 'weight') : null;
  return {
    line,
    values,
    sku: get(row, 'sku') || null,
    price: num(cols.price, 'price'),
    salePrice: num(cols.sale, 'sale price'),
    saleStartsAt: date(get(row, 'date sale price starts', 'sale starts')),
    saleEndsAt: date(get(row, 'date sale price ends', 'sale ends')),
    wholesalePrice: num(cols.wholesale, 'wholesale price'),
    costPrice: num(cols.cost, 'cost price'),
    weightGrams: kg !== null ? Math.round(kg * 1000) : cols.weightGrams ? num(cols.weightGrams, 'weight', wholeNumber) : null,
    stock: num(cols.stock, 'stock', wholeNumber),
    lowStock: num(cols.low, 'low stock level', wholeNumber),
    allowBackorder: ['1', 'yes', 'notify', 'true'].includes(get(row, 'backorders allowed', 'allow backorders').toLowerCase()),
    image: splitImages(get(row, ...cols.image))[0] ?? null,
  };
}

// ---- Our template ----

export const TEMPLATE_COLUMNS = [
  'name',
  'sku',
  'price',
  'sale_price',
  'wholesale_price',
  'cost_price',
  'stock',
  'low_stock_alert',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'category',
  'brand',
  'tags',
  'status',
  'short_description',
  'description',
  'images',
  'specs',
  'weight_grams',
];

export function templateCsv() {
  const rows = [
    TEMPLATE_COLUMNS,
    [
      'Matador Ball Pen Blue (Pack of 10)', 'MT-BP-10', '100', '', '85', '70', '250', '30',
      '', '', '', '', '', '',
      'Writing > Pens', 'Matador', 'school, office', 'published',
      'Smooth everyday ball pen.', 'Long-lasting blue ink. Pack of 10 pens.',
      'https://example.com/images/ball-pen.jpg', 'Ink colour: Blue; Tip size: 0.7 mm', '80',
    ],
    [
      'Spiral Notebook A5 (200 Pages)', 'NB-A5-RULED', '180', '160', '155', '120', '60', '10',
      'Ruling', 'Ruled', '', '', '', '',
      'Notebooks & Diaries > Exercise Books', 'Deli', 'school', 'published',
      'Twin-wire notebook that lies flat.', '', 'https://example.com/images/notebook.jpg', 'Size: A5; Pages: 200', '300',
    ],
    [
      'Spiral Notebook A5 (200 Pages)', 'NB-A5-PLAIN', '180', '', '155', '120', '30', '10',
      'Ruling', 'Plain', '', '', '', '',
      '', '', '', '', '', '', '', '', '300',
    ],
  ];
  return stringify(rows);
}

/** "GSM: 80; Pages: 200" -> [{ name: 'GSM', value: '80' }, ...] */
function readSpecs(text: string) {
  return text
    .split(/[;\n]/)
    .map((pair) => pair.split(/:(.*)/s).map((s) => s.trim()))
    .filter(([name, value]) => name && value)
    .map(([name, value]) => ({ name: name!.slice(0, 60), value: value!.slice(0, 200) }));
}

function readTemplate(rows: { row: Row; line: number }[]): ImportProduct[] {
  const byName = new Map<string, ImportProduct>();
  for (const { row, line } of rows) {
    const name = get(row, 'name', 'product name', 'title');
    if (!name) {
      const p = emptyProduct(`(line ${line})`, line);
      p.problems.push(`Line ${line}: the name is empty`);
      byName.set(`#${line}`, p);
      continue;
    }

    const key = name.toLowerCase();
    let p = byName.get(key);
    const first = !p;
    if (!p) {
      p = emptyProduct(name, line);
      byName.set(key, p);
    } else {
      p.lines.push(line);
    }

    // Product details come from the first line that has them.
    p.status ??= readStatus(get(row, 'status', 'published'));
    p.shortDescription ??= get(row, 'short description') || null;
    p.description ??= textToHtml(get(row, 'description'));
    p.brand ??= get(row, 'brand') || null;
    if (!p.categories.length) p.categories = categoryPaths(get(row, 'category', 'categories'));
    if (!p.tags.length) p.tags = splitList(get(row, 'tags'));
    if (!p.images.length) p.images = splitImages(get(row, 'images', 'image'));
    if (!p.specs.length) p.specs = readSpecs(get(row, 'specs', 'specifications'));
    p.seoTitle ??= get(row, 'seo title') || null;
    p.seoDescription ??= get(row, 'seo description', 'meta description') || null;

    const optionNames = [1, 2, 3].map((n) => get(row, `option${n} name`, `option ${n} name`)).filter(Boolean);
    if (first) p.options = optionNames.map((name) => ({ name, values: [] }));
    const values = p.options.map((_, i) => get(row, `option${i + 1} value`, `option ${i + 1} value`) || null);
    values.forEach((value, i) => {
      if (value && !p.options[i]!.values.some((v) => v.toLowerCase() === value.toLowerCase())) p.options[i]!.values.push(value);
    });

    p.variants.push(
      readVariant(row, line, values, p.problems, {
        price: ['price', 'regular price'],
        sale: ['sale price'],
        wholesale: ['wholesale price'],
        cost: ['cost price', 'cost'],
        stock: ['stock', 'quantity'],
        weightGrams: ['weight grams', 'weight g', 'weight'],
        low: ['low stock alert', 'low stock'],
        image: ['variant image'],
      }),
    );
  }
  return [...byName.values()];
}

// ---- WooCommerce export ----

function readWooCommerce(rows: { row: Row; line: number }[], headers: string[]): ImportProduct[] {
  const wholesaleCols = headers.filter((h) => h.includes('wholesale') && h.includes('price'));
  const attrNumbers = headers
    .map((h) => /^attribute (\d+) name$/.exec(h)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  const attributes = (row: Row) =>
    attrNumbers
      .map((n) => ({ name: get(row, `attribute ${n} name`), value: get(row, `attribute ${n} value s`, `attribute ${n} values`) }))
      .filter((a) => a.name);

  const variantCols = {
    price: ['regular price'],
    sale: ['sale price'],
    wholesale: wholesaleCols,
    cost: ['meta cost price', 'meta wc cog cost', 'cost price'],
    stock: ['stock'],
    weightKg: ['weight kg'],
    low: ['low stock amount'],
    image: ['images'],
  };

  const readStock = (row: Row, v: ImportVariant) => {
    // Empty stock means stock is not managed: "In stock?" 0 means sold out, otherwise always available.
    if (get(row, 'stock') === '' && get(row, 'in stock') === '0') v.stock = 0;
  };

  const products: ImportProduct[] = [];
  const parents = new Map<string, ImportProduct>();

  for (const { row, line } of rows) {
    const type = get(row, 'type').toLowerCase();
    if (type.includes('variation')) continue;

    const name = get(row, 'name');
    const p = emptyProduct(name || `(line ${line})`, line);
    products.push(p);
    if (!name) p.problems.push(`Line ${line}: the name is empty`);
    if (type.includes('grouped') || type.includes('external')) {
      p.problems.push(`Line ${line}: ${type} products are not supported`);
      continue;
    }

    p.status = readStatus(get(row, 'published'));
    p.shortDescription = textToHtml(get(row, 'short description'))?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null;
    p.description = textToHtml(get(row, 'description'));
    p.brand = splitList(get(row, 'brands', 'brand', 'meta brand'))[0] ?? null;
    p.categories = categoryPaths(get(row, 'categories'));
    p.tags = splitList(get(row, 'tags'));
    p.images = splitImages(get(row, 'images'));
    // SEO titles from Yoast or Rank Math, unless they still contain template variables like %%title%%.
    const seoTitle = get(row, 'meta yoast wpseo title', 'meta rank math title');
    const seoDescription = get(row, 'meta yoast wpseo metadesc', 'meta rank math description');
    p.seoTitle = seoTitle && !seoTitle.includes('%') ? seoTitle : null;
    p.seoDescription = seoDescription && !seoDescription.includes('%') ? seoDescription : null;

    if (type.includes('variable')) {
      // Variations come later; attributes used by them become options, the rest become specs.
      p.options = attributes(row).map((a) => ({ name: a.name, values: splitList(a.value) }));
      const id = get(row, 'id');
      if (id) parents.set(`id:${id}`, p);
      const sku = get(row, 'sku');
      if (sku) parents.set(sku.toLowerCase(), p);
    } else {
      p.specs = attributes(row)
        .filter((a) => a.value)
        .map((a) => ({ name: a.name.slice(0, 60), value: splitList(a.value).join(', ').slice(0, 200) }));
      const v = readVariant(row, line, [], p.problems, variantCols);
      v.image = null;
      readStock(row, v);
      p.variants.push(v);
    }
  }

  for (const { row, line } of rows) {
    if (!get(row, 'type').toLowerCase().includes('variation')) continue;
    const parentRef = get(row, 'parent');
    const parent = parents.get(parentRef.toLowerCase()) ?? parents.get(parentRef);
    if (!parent) {
      const orphan = emptyProduct(get(row, 'name') || `(line ${line})`, line);
      orphan.problems.push(`Line ${line}: variation of "${parentRef}", which is not in the file`);
      products.push(orphan);
      continue;
    }
    parent.lines.push(line);
    const attrs = attributes(row);
    const values = parent.options.map((o) => {
      const a = attrs.find((x) => x.name.toLowerCase() === o.name.toLowerCase());
      return a?.value || null;
    });
    if (values.some((v) => v === null)) {
      parent.problems.push(`Line ${line}: a variation must have one value for every option (WooCommerce "Any …" is not supported)`);
    }
    const v = readVariant(row, line, values, parent.problems, variantCols);
    readStock(row, v);
    parent.variants.push(v);
  }

  // Attributes that no variation uses are details, not options.
  for (const p of products) {
    if (!p.options.length) continue;
    const used = p.options.map((_, i) => p.variants.some((v) => v.values[i]));
    p.specs.push(
      ...p.options.filter((_, i) => !used[i]).map((o) => ({ name: o.name.slice(0, 60), value: o.values.join(', ').slice(0, 200) })),
    );
    p.options = p.options.filter((_, i) => used[i]);
    for (const v of p.variants) v.values = v.values.filter((_, i) => used[i]);
    if (!p.variants.length) p.problems.push(`Line ${p.lines[0]}: variable product without variations`);
  }

  return products;
}

export interface Table {
  /** Normalized headers ("Regular price" -> "regular price"). */
  headers: string[];
  rows: { row: Row; line: number }[];
}

/** Rows of a CSV file as text cells. */
export function csvRecords(file: Buffer): string[][] {
  try {
    return parse(file, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  } catch (err) {
    throw badRequest(`This file could not be read as CSV: ${err instanceof Error ? err.message : 'unknown error'}`, {
      file: 'Save the spreadsheet as CSV (comma separated) or Excel (.xlsx) and try again',
    });
  }
}

/** First row = headers. Lines are numbered as in the spreadsheet (headers are line 1). */
export function toTable(records: string[][]): Table {
  const [headerRow, ...dataRows] = records;
  if (!headerRow || !dataRows.length) throw badRequest('The file is empty', { file: 'The file has no product lines' });
  const headers = headerRow.map(normalize);
  return {
    headers,
    rows: dataRows
      .map((cells, i) => ({ row: Object.fromEntries(headers.map((h, n) => [h, cells[n] ?? ''])) as Row, line: i + 2 }))
      .filter(({ row }) => Object.values(row).some((v) => v.trim() !== '')),
  };
}

/** Our template or a WooCommerce export. Returns null for other files. */
export function readProductTable({ headers, rows }: Table): { format: ImportFormat; products: ImportProduct[] } | null {
  const isWoo = headers.includes('type') && headers.includes('regular price') && headers.includes('parent');
  const isTemplate = headers.includes('name') && (headers.includes('price') || headers.includes('regular price'));
  if (isWoo) return { format: 'woocommerce', products: readWooCommerce(rows, headers) };
  if (isTemplate) return { format: 'papertree', products: readTemplate(rows) };
  return null;
}
