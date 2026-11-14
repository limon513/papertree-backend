import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../../docs/common.ts';
import { quoteBody, quoteSchema } from '../settings/schemas.ts';
import {
  steadfastSendBody,
  courierBody,
  customerLookup,
  customerLookupQuery,
  noteBody,
  orderBody,
  orderDetail,
  orderList,
  orderListQuery,
  paymentBody,
  statusBody,
  variantSearchQuery,
  variantSearchResult,
  priceBody,
} from './schemas.ts';

const tags = ['Admin: Orders'];
const security = adminAuth;
const access = 'Needs the Orders section.';

export const ordersDocs: ZodOpenApiPathsObject = {
  '/v1/admin/orders': {
    get: {
      tags,
      security,
      summary: 'List orders',
      description: `${access} Newest first, 50 per page, with the number of orders per status.`,
      requestParams: { query: orderListQuery },
      responses: { '200': json(orderList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Place an order',
      description:
        `${access} For phone, Facebook, WhatsApp and shop orders. Prices come from the products (sale price while it runs, ` +
        'wholesale price for wholesale orders) unless a line gives its own. The delivery charge comes from the delivery zones ' +
        'unless given. Stock is taken from the location right away. The customer is found by phone, or added.',
      requestBody: jsonBody(orderBody),
      responses: { '201': json(orderDetail, 'Placed'), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/orders/variant-search': {
    get: {
      tags,
      security,
      summary: 'Find products to add to an order',
      description: `${access} Searches names, SKUs and option values. Archived products are left out.`,
      requestParams: { query: variantSearchQuery },
      responses: { '200': json(variantSearchResult), ...errors(401, 403) },
    },
  },
  '/v1/admin/orders/delivery-quote': {
    post: {
      tags,
      security,
      summary: 'Work out the delivery charge for an order',
      description: `${access} Same rules as Settings > Delivery: zones, free delivery, weight and wholesale terms.`,
      requestBody: jsonBody(quoteBody),
      responses: { '200': json(quoteSchema), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/orders/price': {
    post: {
      tags,
      security,
      summary: 'Prices for the order form',
      description: `${access} Line prices and the subtotal exactly as the order would be saved, bulk discounts included (retail; a typed price only with bulk: true). Stock is not checked. Nothing is saved.`,
      requestBody: jsonBody(priceBody),
      responses: { '200': json(z.object({}).catchall(z.unknown()).meta({ id: 'OrderPrices' })), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/orders/customer-lookup': {
    get: {
      tags,
      security,
      summary: 'Find a customer by phone',
      description: `${access} Returns the customer, how many orders they placed, and the address of the latest one.`,
      requestParams: { query: customerLookupQuery },
      responses: { '200': json(customerLookup), ...errors(401, 403) },
    },
  },
  '/v1/admin/orders/{id}': {
    get: {
      tags,
      security,
      summary: 'Get an order',
      description: `${access} With items, payments, history and the statuses it can move to.`,
      requestParams: { path: idParam },
      responses: { '200': json(orderDetail), ...errors(401, 403, 404) },
    },
    put: {
      tags,
      security,
      summary: 'Change an order',
      description: `${access} Only pending or confirmed orders. Stock follows the new quantities.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(orderBody),
      responses: { '200': json(orderDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/orders/{id}/status': {
    post: {
      tags,
      security,
      summary: 'Move an order to another status',
      description:
        `${access} pending → confirmed → packed → shipped → delivered; cancelled or returned give the stock back. ` +
        'With collectDue on delivery, the unpaid amount is recorded as cash on delivery.',
      requestParams: { path: idParam },
      requestBody: jsonBody(statusBody),
      responses: { '200': json(orderDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/orders/{id}/payments': {
    post: {
      tags,
      security,
      summary: 'Record a payment or refund',
      description: `${access} A negative amount is money paid back. The payment status follows the total paid.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(paymentBody),
      responses: { '200': json(orderDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/orders/{id}/notes': {
    post: {
      tags,
      security,
      summary: 'Add a note to the history',
      description: `${access} Staff only; customers never see it.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(noteBody),
      responses: { '200': json(orderDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/orders/{id}/courier': {
    put: {
      tags,
      security,
      summary: 'Set the courier and tracking code',
      description: access,
      requestParams: { path: idParam },
      requestBody: jsonBody(courierBody),
      responses: { '200': json(orderDetail), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/orders/courier/steadfast': {
    post: {
      tags,
      security,
      summary: 'Send orders to Steadfast',
      description:
        `${access} One parcel per order (confirmed or packed, not sent before, advance paid). Cash to collect = total − paid. ` +
        'Each order is claimed first, so a double click never makes two parcels. markShipped also marks them shipped (and notify tells the customers). ' +
        'The answer has one result per order: ok with consignmentId and trackingCode, or why not.',
      requestBody: jsonBody(steadfastSendBody),
      responses: {
        '200': json(
          z.object({
            results: z.array(
              z.object({ id: z.number(), number: z.number().nullable(), ok: z.boolean(), consignmentId: z.string().optional(), trackingCode: z.string().optional(), cod: z.number().optional(), message: z.string().nullable() }),
            ),
          }),
        ),
        ...errors(400, 401, 403),
      },
    },
  },
  '/v1/admin/orders/{id}/courier/refresh': {
    post: {
      tags,
      security,
      summary: 'Ask Steadfast where the parcel is',
      description: `${access} Saves the status; "delivered" can mark the order delivered (Integrations → Steadfast).`,
      requestParams: { path: idParam },
      responses: { '200': json(z.object({ status: z.string(), changed: z.boolean(), note: z.string().nullable(), order: orderDetail })), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/webhooks/steadfast': {
    post: {
      tags: ['Webhooks'],
      summary: 'Steadfast parcel updates',
      description:
        'Called by Steadfast. Headers: Authorization: Bearer <token>, X-Signature: HMAC-SHA256 (hex) of the raw body keyed with the token (both checked), Idempotency-Key. ' +
        'notification_type delivery_status { consignment_id, invoice, status, cod_amount, delivery_charge, tracking_message, updated_at } saves the status (delivered can finish the order); ' +
        'tracking_update / consignment_update / cancel_request / return_request are noted in the order history; other events are ignored. The same event twice changes nothing. ' +
        '401 without the right token and signature, 404 when no order has the parcel (Steadfast does not retry 4xx).',
      requestBody: jsonBody(z.object({ consignment_id: z.union([z.number(), z.string()]), invoice: z.string().optional(), status: z.string(), cod_amount: z.number().optional() })),
      responses: { '200': json(z.object({ status: z.string(), message: z.string() })), ...errors(401, 404) },
    },
  },
};
