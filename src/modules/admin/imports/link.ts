import { inBatches } from '../../../lib/batches.ts';
import { cleanHtml, decodeEntities, htmlToText } from '../../../lib/html.ts';
import { FetchError, fetchPublic } from '../../../lib/safe-fetch.ts';
import { MAX_OPTIONS, MAX_VARIANTS } from '../products/schemas.ts';

/**
 * Reads a product page from another shop (Daraz, a WooCommerce or Shopify shop, or any site that
 * describes its products the standard way) and returns what it found, to start a draft product.
 *
 * Every page is read the general way (schema.org data and Open Graph tags). Where the site has
 * richer data we know how to read, that is used first:
 * - WooCommerce: the shop's public Store API (prices, variations, categories, attributes)
 * - Shopify: the product's .js data (variants with prices)
 * - Daraz: the data embedded in the page (gallery, colour/size options)
 */

export type LinkSource = 'woocommerce' | 'shopify' | 'daraz' | 'page';

export interface LinkVariant {
  /** Values for the product's options, in the same order. */
  values: string[];
  price: number | null;
  salePrice: number | null;
  image: string | null;
}

export interface LinkProduct {
  url: string;
  site: string;
  source: LinkSource;
  name: string;
  shortDescription: string | null;
  description: string | null;
  /** Prices of a product without variants (or the first variant's). */
  price: number | null;
  salePrice: number | null;
  /** "BDT", "USD", ... null when the page does not say. */
  currency: string | null;
  brand: string | null;
  /** Category names on the site, broadest first. */
  categories: string[];
  tags: string[];
  specs: { name: string; value: string }[];
  images: string[];
  options: { name: string; values: string[] }[];
  variants: LinkVariant[];
  /** Things the user should know, e.g. "The price was not on the page". */
  notes: string[];
}

export type Found = Partial<Omit<LinkProduct, 'url' | 'site' | 'notes'>>;

const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_DATA_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 20;
const MAX_VARIATION_FETCHES = 30;

// ---- Small helpers ----

const text = (v: unknown) => (typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim() || null : null);

/** "৳ 1,250.00", "Tk. 80", 80 -> 1250 / 80. */
function amount(v: unknown) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const digits = v.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return digits ? Number(digits[0]) : null;
}

/** Regular and sale price in the form the product uses: price is the higher one. */
function prices(regular: number | null, sale: number | null) {
  if (regular !== null && sale !== null && sale < regular) return { price: regular, salePrice: sale };
  return { price: regular ?? sale, salePrice: null };
}

function absolute(link: unknown, base: string) {
  if (typeof link !== 'string' || !link.trim() || link.startsWith('data:')) return null;
  try {
    const url = new URL(link.trim().startsWith('//') ? `https:${link.trim()}` : link.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const unique = <T>(list: T[]) => [...new Set(list)];

async function fetchJson(url: string) {
  const { body } = await fetchPublic(url, { maxBytes: MAX_DATA_BYTES, timeoutMs: 15_000, accept: 'application/json' });
  return JSON.parse(body.toString('utf8')) as unknown;
}

/** The JSON value that starts at `from` in `html` (an object or array), or null. */
function jsonAt(html: string, from: number) {
  const open = html[from];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try {
        return JSON.parse(html.slice(from, i + 1)) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---- Any page: schema.org (JSON-LD) and Open Graph ----

export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function metaTags(html: string) {
  const tags = new Map<string, string[]>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) attrs.set(m[1]!.toLowerCase(), m[3] ?? m[4] ?? '');
    const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content) tags.set(key, [...(tags.get(key) ?? []), decodeEntities(content)]);
  }
  return tags;
}

function jsonLdProduct(html: string): Json | null {
  const nodes: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      nodes.push(JSON.parse(m[1]!.trim()));
    } catch {
      // Broken data on the page: ignore it.
    }
  }
  const all: Json[] = [];
  const walk = (v: unknown) => {
    for (const item of list(v)) {
      if (!isObject(item)) continue;
      all.push(item);
      if (item['@graph']) walk(item['@graph']);
    }
  };
  walk(nodes);
  const isType = (node: Json, type: string) => list(node['@type']).includes(type);
  return all.find((n) => isType(n, 'Product')) ?? all.find((n) => isType(n, 'ProductGroup')) ?? null;
}

function readPage(html: string, url: string): Found {
  const meta = metaTags(html);
  const first = (key: string) => meta.get(key)?.[0] ?? null;
  const ld = jsonLdProduct(html);

  let name = text(ld?.name);
  if (!name) {
    // og:title and <title> usually end with the shop name: "Pen | Daraz.com.bd", "Pen - PAPERTREE".
    name = text(first('og:title')) ?? text(html.match(/<title[^>]*>([^<]*)/i)?.[1]);
    const site = [first('og:site_name'), new URL(url).hostname.replace(/^www\./, '')].filter(Boolean) as string[];
    const tail = name?.match(/^(.+?)\s+[|\-–—:]\s+([^|\-–—]+)$/);
    if (tail && site.some((s) => tail[2]!.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(tail[2]!.toLowerCase().trim()))) {
      name = tail[1]!.trim();
    }
  }

  const images: string[] = [];
  for (const img of list(ld?.image)) {
    const link = absolute(isObject(img) ? (img.url ?? img.contentUrl) : img, url);
    if (link) images.push(link);
  }
  if (!images.length) for (const og of meta.get('og:image') ?? []) images.push(absolute(og, url)!);

  // Offer, list of offers, or AggregateOffer.
  const offers = list(ld?.offers).filter(isObject);
  const offer = offers[0];
  const spec = isObject(offer?.priceSpecification) ? offer.priceSpecification : list(offer?.priceSpecification).find(isObject);
  const price =
    amount(offer?.price) ?? amount(offer?.lowPrice) ?? amount(spec?.price) ?? amount(first('product:price:amount') ?? first('og:price:amount'));
  const currency =
    text(offer?.priceCurrency) ?? text(spec?.priceCurrency) ?? text(first('product:price:currency') ?? first('og:price:currency'));

  const brand = isObject(ld?.brand) ? text(ld.brand.name) : text(ld?.brand);
  const category = text(ld?.category);
  const description = text(ld?.description) ?? text(first('og:description')) ?? text(first('description'));

  // A page that only has a title (a home page, a blog post) is not a product.
  const isProduct = !!ld || /product/i.test(first('og:type') ?? '') || price !== null;
  if (!isProduct) return { source: 'page' };

  return {
    source: 'page',
    name: name ?? undefined,
    description: description ? `<p>${description.replace(/</g, '&lt;')}</p>` : undefined,
    price,
    currency,
    brand,
    categories: category ? category.split(/\s*[>›/]\s*/).filter(Boolean) : [],
    specs: list(ld?.additionalProperty)
      .filter(isObject)
      .flatMap((p) => {
        const n = text(p.name);
        const v = text(typeof p.value === 'number' ? String(p.value) : p.value);
        return n && v ? [{ name: n, value: v }] : [];
      }),
    images: images.filter(Boolean),
  };
}

// ---- WooCommerce: the shop's Store API ----

interface WooPrices {
  regular_price?: string;
  sale_price?: string;
  price?: string;
  currency_code?: string;
  currency_minor_unit?: number;
}

function wooPrices(p: WooPrices | undefined, onSale: boolean) {
  const unit = 10 ** (p?.currency_minor_unit ?? 2);
  const money = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) / unit : null);
  return prices(money(p?.regular_price) ?? money(p?.price), onSale ? money(p?.sale_price) : null);
}

async function readWooCommerce(url: URL): Promise<Found | null> {
  const slug = url.pathname.split('/').filter(Boolean).pop();
  if (!slug) return null;
  const api = `${url.origin}/wp-json/wc/store/v1/products`;
  const found = await fetchJson(`${api}?slug=${encodeURIComponent(slug)}`).catch(() => null);
  const p = list(found).find(isObject);
  if (!p) return null;
  return fromWooStore(p, api, url.toString());
}

/**
 * A product from a WooCommerce Store API answer, with its variations (one request each). Also used to
 * copy the whole catalogue from the old site.
 */
export async function fromWooStore(p: Json, api: string, base: string): Promise<Found> {
  const names = (v: unknown) => list(v).filter(isObject).map((x) => text(x.name)).filter((x): x is string => !!x);
  const attributes = list(p.attributes).filter(isObject);
  const optionAttrs = attributes.filter((a) => a.has_variations).slice(0, MAX_OPTIONS);
  const options = optionAttrs.map((a) => ({ name: text(a.name) ?? 'Option', values: names(a.terms) }));

  // Variation prices and images need one request each.
  let variants: LinkVariant[] = [];
  const variations = list(p.variations).filter(isObject).slice(0, MAX_VARIATION_FETCHES);
  if (p.type === 'variable' && options.length && variations.length) {
    const details = await inBatches(variations, 6, (v) => fetchJson(`${api}/${Number(v.id)}`).catch(() => null));
    variants = variations.flatMap((v, i) => {
      const chosen = list(v.attributes).filter(isObject);
      const values = optionAttrs.map((a) => {
        const pick = chosen.find((c) => text(c.name)?.toLowerCase() === text(a.name)?.toLowerCase());
        const value = typeof pick?.value === 'string' ? pick.value : '';
        // Variations store the term slug; show the term name.
        const term = list(a.terms).filter(isObject).find((t) => t.slug === value || text(t.name)?.toLowerCase() === value.toLowerCase());
        return term ? text(term.name) : text(value);
      });
      // "Any colour" variations can't be one of our variants.
      if (values.some((x) => !x)) return [];
      const d = isObject(details[i]) ? details[i] : null;
      return [
        {
          values: values as string[],
          ...wooPrices(d?.prices as WooPrices | undefined, d?.on_sale === true),
          image: absolute(list(d?.images).filter(isObject)[0]?.src, base),
        },
      ];
    });
  }

  const short = typeof p.short_description === 'string' ? htmlToText(p.short_description) : '';
  return {
    source: 'woocommerce',
    name: text(p.name) ?? undefined,
    shortDescription: short || null,
    description: typeof p.description === 'string' ? p.description : null,
    ...wooPrices(p.prices as WooPrices | undefined, p.on_sale === true),
    currency: text((p.prices as WooPrices | undefined)?.currency_code),
    brand: names(p.brands)[0] ?? null,
    categories: names(p.categories),
    tags: names(p.tags),
    specs: attributes
      .filter((a) => !a.has_variations)
      .flatMap((a) => {
        const n = text(a.name);
        const v = names(a.terms).join(', ');
        return n && v ? [{ name: n, value: v }] : [];
      }),
    images: list(p.images)
      .filter(isObject)
      .map((img) => absolute(img.src, base))
      .filter((x): x is string => !!x),
    options: variants.length ? options : [],
    variants,
  };
}

// ---- Shopify: /products/<handle>.js ----

async function readShopify(url: URL, html: string): Promise<Found | null> {
  const handle = url.pathname.match(/\/products\/([^/?#]+)/)?.[1];
  if (!handle) return null;
  const p = await fetchJson(`${url.origin}/products/${handle}.js`).catch(() => null);
  if (!isObject(p)) return null;

  const optionList = list(p.options).map((o) =>
    isObject(o) ? { name: text(o.name) ?? 'Option', values: list(o.values).map(text).filter((x): x is string => !!x) } : null,
  );
  // A product without options has one option "Title" with the value "Default Title".
  const options = optionList
    .filter((o): o is { name: string; values: string[] } => !!o)
    .filter((o) => !(o.name === 'Title' && o.values.length === 1 && o.values[0] === 'Default Title'))
    .slice(0, MAX_OPTIONS);
  const cents = (v: unknown) => (typeof v === 'number' ? v / 100 : null);
  const variants = list(p.variants)
    .filter(isObject)
    .map((v) => ({
      values: options.map((_, i) => text(v[`option${i + 1}`]) ?? ''),
      ...prices(cents(v.compare_at_price) ?? cents(v.price), cents(v.price)),
      image: absolute(isObject(v.featured_image) ? v.featured_image.src : null, url.toString()),
    }));
  const currency = html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/)?.[1] ?? null;

  return {
    source: 'shopify',
    name: text(p.title) ?? undefined,
    description: typeof p.description === 'string' ? p.description : null,
    ...(variants[0] ? { price: variants[0].price, salePrice: variants[0].salePrice } : {}),
    currency,
    brand: text(p.vendor),
    categories: text(p.type) ? [text(p.type)!] : [],
    // Shopify tags are mostly the shop's own codes, so they are not copied.
    images: list(p.images)
      .map((img) => absolute(img, url.toString()))
      .filter((x): x is string => !!x),
    options: options.length ? options : [],
    variants: options.length ? variants : [],
  };
}

// ---- Daraz: data embedded in the page ----

function readDaraz(html: string): Found | null {
  const start = html.match(/__moduleData__\s*=\s*/);
  const data = start ? jsonAt(html, start.index! + start[0].length) : null;
  const fields = isObject(data) && isObject(data.data) && isObject(data.data.root) ? data.data.root.fields : null;
  if (!isObject(fields)) return null;

  const product = isObject(fields.product) ? fields.product : {};
  const tracking = isObject(fields.tracking) ? fields.tracking : {};
  const core = isObject(tracking.core) ? tracking.core : {};
  const brandName = isObject(product.brand) ? text(product.brand.name) : null;

  const galleries = isObject(fields.skuGalleries) ? fields.skuGalleries : {};
  const gallery = list(galleries['0'] ?? Object.values(galleries)[0])
    .filter(isObject)
    .filter((g) => g.type === 'img')
    .map((g) => absolute(g.src, 'https://www.daraz.com.bd/'))
    .filter((x): x is string => !!x);

  // Options (like Color family) and their combinations. Daraz shows one price for all of them.
  const skuBase = isObject(fields.productOption) && isObject(fields.productOption.skuBase) ? fields.productOption.skuBase : {};
  const properties = list(skuBase.properties).filter(isObject).slice(0, MAX_OPTIONS);
  const options = properties.map((prop) => ({
    name: text(prop.name) ?? 'Option',
    values: list(prop.values).filter(isObject).map((v) => text(v.name)).filter((x): x is string => !!x),
  }));
  const price = amount(tracking.pdt_price);
  const variants: LinkVariant[] = list(skuBase.skus)
    .filter(isObject)
    .flatMap((sku) => {
      const path = new Map(
        String(sku.propPath ?? '')
          .split(';')
          .map((pair) => pair.split(':') as [string, string]),
      );
      let image: string | null = null;
      const values = properties.map((prop) => {
        const value = list(prop.values).filter(isObject).find((v) => String(v.vid) === path.get(String(prop.pid)));
        image ??= absolute(value?.image, 'https://www.daraz.com.bd/');
        return value ? text(value.name) : null;
      });
      return values.every(Boolean) ? [{ values: values as string[], price, salePrice: null, image }] : [];
    });

  const highlights = typeof product.highlights === 'string' ? product.highlights : '';
  const desc = typeof product.desc === 'string' ? product.desc : '';
  return {
    source: 'daraz',
    name: text(product.title) ?? text(tracking.pdt_name) ?? undefined,
    description: highlights + desc || null,
    price,
    salePrice: null,
    currency: text(core.currencyCode) ?? 'BDT',
    brand: brandName,
    categories: list(tracking.pdt_category).map(text).filter((x): x is string => !!x),
    images: gallery,
    options: variants.length > 1 ? options : [],
    variants: variants.length > 1 ? variants : [],
  };
}

// ---- Putting it together ----

const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

export async function readProductLink(raw: string): Promise<LinkProduct> {
  const page = await fetchPublic(raw, { maxBytes: MAX_PAGE_BYTES, timeoutMs: 20_000, accept: 'text/html,application/xhtml+xml' });
  if (!/html|xml/i.test(page.contentType) && page.contentType) throw new FetchError('This link is not a web page');
  const html = page.body.toString('utf8');
  const url = new URL(page.url);
  const host = url.hostname.replace(/^www\./, '');

  const general = readPage(html, url.toString());
  let special: Found | null = null;
  if (/(^|\.)daraz\.(com\.bd|pk|lk|com\.np)$/.test(host)) special = readDaraz(html);
  else if (/cdn\.shopify\.com|Shopify\.shop/.test(html)) special = await readShopify(url, html);
  else if (/woocommerce|wc-block|\/wp-json\//i.test(html)) special = await readWooCommerce(url);

  // The richer data wins; the general reading fills the gaps.
  const merged: Found = { ...general };
  for (const [key, value] of Object.entries(special ?? {})) if (filled(value)) (merged as Record<string, unknown>)[key] = value;

  if (!merged.name) {
    const blocked = /punish|captcha|x5sec|cf-chl|challenge-platform/i.test(html);
    throw new FetchError(
      blocked
        ? 'The site asked for a robot check, so the page could not be read. Try again in a few minutes.'
        : 'No product was found on this page. Check that the link opens one product.',
    );
  }

  const aliExpressPage = /aliexpress\./.test(host) && merged.source === 'page';
  // AliExpress's page description is its own slogan, not the product's.
  let description = merged.description && !aliExpressPage ? cleanHtml(merged.description, { copied: true }) : null;
  const notes: string[] = [];
  if (description && description.length > 100_000) {
    description = null;
    notes.push('The description was too long to copy.');
  }

  const currency = merged.currency?.toUpperCase() ?? null;
  let options = (merged.options ?? []).filter((o) => o.values.length > 0);
  let variants = (merged.variants ?? []).slice(0, MAX_VARIANTS);
  if (!options.length || variants.length < 2) {
    options = [];
    variants = [];
  }

  const images = unique([...(merged.images ?? [])]).slice(0, MAX_IMAGES);
  const price = merged.price ?? null;

  if (price === null) notes.push('The price was not on the page. Enter your price.');
  else if (currency && currency !== 'BDT') notes.push(`Prices on the site are in ${currency}. Enter your own prices in Taka.`);
  if (aliExpressPage) {
    notes.push('AliExpress only shares the name and main picture with other websites. Add the details yourself.');
  }
  if (!images.length) notes.push('No pictures were found. Add them on the product page.');

  return {
    url: url.toString(),
    site: host,
    source: merged.source ?? 'page',
    name: merged.name.slice(0, 200),
    shortDescription: merged.shortDescription?.slice(0, 1000) ?? null,
    description,
    price,
    salePrice: merged.salePrice ?? null,
    currency,
    brand: merged.brand && !/^(no brand|generic|unbranded|n\/a)$/i.test(merged.brand) ? merged.brand.slice(0, 100) : null,
    categories: unique(merged.categories ?? []).slice(0, 10),
    tags: unique(merged.tags ?? []).slice(0, 30),
    specs: (merged.specs ?? []).slice(0, 50),
    images,
    options,
    variants,
    notes,
  };
}
