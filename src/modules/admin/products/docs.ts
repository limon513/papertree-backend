import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import {
  bulkResult,
  MAX_VARIANTS,
  productBody,
  productBulkBody,
  productList,
  productListQuery,
  productSchema,
  stockLocationList,
  stockUpdateBody,
  stockUpdateResult,
} from './schemas.ts';

const tags = ['Admin: Products'];
const security = adminAuth;
const access = 'Needs the Products section.';

export const productsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/products': {
    get: {
      tags,
      security,
      summary: 'List products',
      description: `${access} Search matches the name or a variant SKU. \`counts\` gives the number per status for the same search and filters.`,
      requestParams: { query: productListQuery },
      responses: { '200': json(productList), ...errors(400, 401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Create a product',
      description:
        `${access} Every product has at least one variant (up to ${MAX_VARIANTS}). ` +
        'A simple product has no options and one variant. Prices and stock are per variant.',
      requestBody: jsonBody(productBody),
      responses: { '201': json(productSchema, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/products/bulk': {
    post: {
      tags,
      security,
      summary: 'Change many products at once',
      description: `${access} Publish, unpublish or archive, add or remove a category, set the brand, or delete. Up to 500 products.`,
      requestBody: jsonBody(productBulkBody),
      responses: { '200': json(bulkResult), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/products/stock': {
    patch: {
      tags,
      security,
      summary: 'Update stock quickly',
      description:
        `${access} Send the new quantity and the quantity you saw (baseQuantity), so only the difference is applied. ` +
        'Every change is recorded in the stock history.',
      requestBody: jsonBody(stockUpdateBody),
      responses: { '200': json(stockUpdateResult), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/products/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a product',
      requestParams: { path: idParam },
      responses: { '200': json(productSchema), ...errors(401, 403, 404) },
    },
    put: {
      tags,
      security,
      summary: 'Save a product',
      description:
        `${access} Send the whole product. Variants with an id are updated, without an id are added, ` +
        'and missing ones are removed. For stock, send `baseQuantity` (the number the form showed) so only the change is applied.',
      requestParams: { path: idParam },
      requestBody: jsonBody(productBody),
      responses: { '200': json(productSchema), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a product',
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/products/{id}/duplicate': {
    post: {
      tags,
      security,
      summary: 'Duplicate a product',
      description: `${access} Makes a draft copy without SKUs or stock.`,
      requestParams: { path: idParam },
      responses: { '201': json(productSchema, 'Created'), ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/stock-locations': {
    get: {
      tags,
      security,
      summary: 'List stock locations',
      description: `${access} Active locations, default first.`,
      responses: { '200': json(stockLocationList), ...errors(401, 403) },
    },
  },
};
