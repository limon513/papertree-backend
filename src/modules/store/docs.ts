import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errors, json, jsonBody } from '../../docs/common.ts';
import { locationsSchema } from '../admin/settings/schemas.ts';
import { cartBody, productListQuery, suggestQuery } from './schemas.ts';

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
      description: `${note} Deals (biggest discount first), new arrivals, best sellers (last 90 days) and one row per main category.`,
      responses: { '200': json(open.meta({ id: 'StoreHome' })) },
    },
  },
  '/v1/store/products': {
    get: {
      tags,
      summary: 'List products (category, brand, search, deals)',
      description: `${note} With the category (breadcrumbs, sub-categories) and filters: brands with counts and the price range.`,
      requestParams: { query: productListQuery },
      responses: { '200': json(open.meta({ id: 'StoreProductList' })), ...errors(400, 404) },
    },
  },
  '/v1/store/suggest': {
    get: {
      tags,
      summary: 'Search as you type',
      description: `${note} Up to 6 products, 4 categories and 3 brands.`,
      requestParams: { query: suggestQuery },
      responses: { '200': json(open.meta({ id: 'StoreSuggest' })), ...errors(400) },
    },
  },
  '/v1/store/products/{slug}': {
    get: {
      tags,
      summary: 'A product page',
      description: `${note} Images, variants with price and stock, specifications, breadcrumbs and related products.`,
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
};
