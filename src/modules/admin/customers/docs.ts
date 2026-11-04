import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../../docs/common.ts';
import { addressBody, blockBody, businessBody, customerBody, customerDetail, customerList, customerListQuery } from './schemas.ts';

const tags = ['Admin: Customers'];
const security = adminAuth;
const access = 'Needs the Customers section.';
const addressParams = z.object({
  id: z.string().meta({ description: 'Customer id', example: '1' }),
  addressId: z.string().meta({ description: 'Address id', example: '1' }),
});

export const customersDocs: ZodOpenApiPathsObject = {
  '/v1/admin/customers': {
    get: {
      tags,
      security,
      summary: 'List customers',
      description: `${access} 50 per page, with orders, spending and what is still owed, plus counts per view.`,
      requestParams: { query: customerListQuery },
      responses: { '200': json(customerList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a customer',
      description: `${access} A business added by staff is approved straight away. 409 if the phone number is already a customer.`,
      requestBody: jsonBody(customerBody),
      responses: { '201': json(customerDetail, 'Added'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/customers/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a customer',
      description: `${access} With spending, saved addresses and the latest 50 orders.`,
      requestParams: { path: idParam },
      responses: { '200': json(customerDetail), ...errors(401, 403, 404) },
    },
    put: {
      tags,
      security,
      summary: 'Change a customer',
      description: access,
      requestParams: { path: idParam },
      requestBody: jsonBody(customerBody),
      responses: { '200': json(customerDetail), ...errors(400, 401, 403, 404, 409) },
    },
  },
  '/v1/admin/customers/{id}/business': {
    put: {
      tags,
      security,
      summary: 'Approve or reject a business, and set its terms',
      description:
        `${access} An approved business gets wholesale prices. Its own terms (advance, minimum order, delivery) ` +
        'replace the shop terms on its wholesale orders; empty fields keep the shop terms.',
      requestParams: { path: idParam },
      requestBody: jsonBody(businessBody),
      responses: { '200': json(customerDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/customers/{id}/block': {
    put: {
      tags,
      security,
      summary: 'Block or unblock a customer',
      description: `${access} Blocked customers cannot order on the website; staff see a warning when they take an order.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(blockBody),
      responses: { '200': json(customerDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/customers/{id}/addresses': {
    post: {
      tags,
      security,
      summary: 'Add a saved address',
      description: `${access} The first address becomes the default.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(addressBody),
      responses: { '201': json(customerDetail, 'Added'), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/customers/{id}/addresses/{addressId}': {
    put: {
      tags,
      security,
      summary: 'Change a saved address',
      description: access,
      requestParams: { path: addressParams },
      requestBody: jsonBody(addressBody),
      responses: { '200': json(customerDetail), ...errors(400, 401, 403, 404) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a saved address',
      description: `${access} Another address becomes the default if needed.`,
      requestParams: { path: addressParams },
      responses: { '200': json(customerDetail), ...errors(401, 403, 404) },
    },
  },
};
