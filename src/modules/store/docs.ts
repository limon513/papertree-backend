import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errors, json, jsonBody } from '../../docs/common.ts';
import { locationsSchema } from '../admin/settings/schemas.ts';
import { cartBody, checkoutBody, productListQuery, productRequestBody, searchLogBody, suggestQuery } from './schemas.ts';

const tags = ['Store (public)'];
const open = z.object({}).catchall(z.unknown());
const note = 'No sign-in. Only active products, categories and brands. Prices are today\'s retail prices; stock is at the default location.';

export const storeDocs: ZodOpenApiPathsObject = {
  '/v1/store/catalog': {
    get: {
      tags,
      summary: 'Menus and store details',
      description: `${note} Category tree (empty ones hidden) with product counts, brands, and the store details for the header and footer.`,
      responses: { '200': json(open.meta({ id: 'StoreCatalog' })) },
    },
  },
  '/v1/store/places': {
    get: {
      tags,
      summary: 'Districts and areas of Bangladesh',
      description: 'For "Deliver to" and address forms.',
      responses: { '200': json(locationsSchema) },
    },
  },
  '/v1/store/home': {
    get: {
      tags,
      summary: 'Home page rows',
      description: `${note} Banners shown now (hero slider up to 8, tiles up to 2), deals (biggest discount first), new arrivals, best sellers (last 90 days) and one row per main category.`,
      responses: { '200': json(open.meta({ id: 'StoreHome' })) },
    },
  },
  '/v1/store/products': {
    get: {
      tags,
      summary: 'List products (category, brand, search, deals)',
      description:
        `${note} With the category (breadcrumbs, sub-categories) and filters: brands with counts and the price range. ` +
        'With q, "search" tells what was searched: typos fixed (corrected, searched), whether only some words matched (partial), and a product slug when q is exactly a SKU (sku).',
      requestParams: { query: productListQuery },
      responses: { '200': json(open.meta({ id: 'StoreProductList' })), ...errors(400, 404) },
    },
  },
  '/v1/store/suggest': {
    get: {
      tags,
      summary: 'Search as you type',
      description: `${note} Up to 6 products (best match first, typos fixed, synonyms used), 4 categories and 3 brands.`,
      requestParams: { query: suggestQuery },
      responses: { '200': json(open.meta({ id: 'StoreSuggest' })), ...errors(400) },
    },
  },
  '/v1/store/products/{slug}': {
    get: {
      tags,
      summary: 'A product page',
      description: `${note} Images, variants with price and stock, specifications, breadcrumbs, and up to 12 related products in stock (from the same category, widened to its parent when it has fewer than 4).`,
      requestParams: { path: z.object({ slug: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StoreProduct' })), ...errors(404) },
    },
  },
  '/v1/store/cart': {
    post: {
      tags,
      summary: 'Check a cart',
      description:
        `${note} The cart lives in the browser; this returns today's prices, what is available (quantities are lowered to the stock), ` +
        'and with a district the delivery charge and how much more is needed for free delivery. Nothing is saved.',
      requestBody: jsonBody(cartBody),
      responses: { '200': json(open.meta({ id: 'StoreCart' })), ...errors(400) },
    },
  },
  '/v1/store/search-log': {
    post: {
      tags,
      summary: 'Record a search',
      description: "Sent by the shopper's browser after a search page shows, for the search report (searches with no results, corrected words). Nothing is returned.",
      requestBody: jsonBody(searchLogBody),
      responses: { '204': { description: 'Recorded' } },
    },
  },
  '/v1/store/product-requests': {
    post: {
      tags,
      summary: 'Request a product',
      description:
        'A shopper asks for something the shop does not have (from a search that found nothing). Staff see it in the admin. ' +
        'At most 5 per visitor per hour. "website" must stay empty (a hidden box that only bots fill).',
      requestBody: jsonBody(productRequestBody),
      responses: { '201': json(z.object({ ok: z.boolean() }), 'Sent'), ...errors(400, 429) },
    },
  },
  '/v1/store/orders': {
    post: {
      tags,
      summary: 'Place an order (checkout)',
      description:
        'Cash on delivery. Prices, stock and the delivery charge are worked out by the API, never taken from the browser. ' +
        'The customer is found by phone number (or added) and the address saved. Stock is taken at once. ' +
        '409 PRICE_CHANGED: the total is no longer expectedTotal (prices changed); check the cart and send again. ' +
        '400 with fields items.N.quantity: not enough stock (someone may have just bought the last ones). ' +
        'The same requestId again returns the order already placed (200), so retries never make two orders. ' +
        'At most 20 orders per connection per hour. Returns the order number and the token for GET /v1/store/orders/{token}.',
      requestBody: jsonBody(checkoutBody),
      responses: {
        '201': json(z.object({ number: z.number(), token: z.string().nullable(), total: z.number() }).meta({ id: 'StoreOrderPlaced' }), 'Placed'),
        '200': json(z.object({ number: z.number(), token: z.string().nullable(), total: z.number() }), 'Already placed (same requestId)'),
        ...errors(400, 409, 429),
      },
    },
  },
  '/v1/store/orders/{token}': {
    get: {
      tags,
      summary: 'An order, for its thank-you page',
      description: 'The token from placing the order is the only key (no sign-in). Items, address, totals and status.',
      requestParams: { path: z.object({ token: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StoreOrder' })), ...errors(404) },
    },
  },
};
