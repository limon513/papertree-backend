import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../../docs/common.ts';
import {
  productRequestList,
  productRequestListQuery,
  productRequestUpdate,
  productRequestView,
  supplierLeadList,
  supplierLeadListQuery,
  supplierLeadUpdate,
  supplierLeadView,
} from './schemas.ts';

const tags = ['Admin: Requests'];
const security = adminAuth;
const access = 'Needs the Requests & Leads section.';

export const requestsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/product-requests': {
    get: {
      tags,
      security,
      summary: 'List product requests',
      description: `${access} "Request this product" from the website, 50 per page. New ones oldest first (waiting longest), done ones latest first. customerId is set when the phone number is a customer.`,
      requestParams: { query: productRequestListQuery },
      responses: { '200': json(productRequestList), ...errors(401, 403) },
    },
  },
  '/v1/admin/product-requests/{id}': {
    put: {
      tags,
      security,
      summary: 'Mark a request done (or new again), with a note',
      description: `${access} Who marked it done, and when, is kept.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(productRequestUpdate),
      responses: { '200': json(productRequestView), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/supplier-leads': {
    get: {
      tags,
      security,
      summary: 'List "Sell with us" leads',
      description: `${access} Brands and suppliers who want to sell through the shop, 50 per page. New ones oldest first (waiting longest), the rest latest first.`,
      requestParams: { query: supplierLeadListQuery },
      responses: { '200': json(supplierLeadList), ...errors(401, 403) },
    },
  },
  '/v1/admin/supplier-leads/{id}': {
    put: {
      tags,
      security,
      summary: 'Move a lead to in talks or done (or new again), with a note',
      description: `${access} Who picked it up, and when, is kept.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(supplierLeadUpdate),
      responses: { '200': json(supplierLeadView), ...errors(400, 401, 403, 404) },
    },
  },
};
