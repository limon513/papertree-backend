import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../docs/common.ts';
import { quotationListQuery } from '../admin/quotations/routes.ts';
import { quotationBody, quotationOrderBody, quotationPlaceBody } from '../store/quotations.ts';

const token = z.object({ token: z.string().meta({ description: 'The secret in the quotation link' }) });
const placed = z.object({ number: z.number(), token: z.string().nullable(), total: z.number(), payUrl: z.string().optional(), payError: z.string().optional() });
const adminTags = ['Admin: Quotations'];
const access = 'Needs the Orders section.';

/** Quotations: the website (make, view, order) and the admin (list, detail, cancel). */
export const quotationsDocs: ZodOpenApiPathsObject = {
  '/v1/store/quotations': {
    post: {
      tags: ['Store'],
      summary: 'Make a quotation from the cart',
      description:
        'Prices worked out as an order’s (today’s price or a signed-in business’s wholesale price, then bulk discounts) and fixed for 7 days. ' +
        'Products no longer for sale are refused. Linked to a customer only when signed in. 15 per visitor per hour. "website" must stay empty.',
      requestBody: jsonBody(quotationBody),
      responses: { '201': json(z.object({ number: z.string().nullable(), token: z.string().nullable() }), 'Made'), ...errors(400, 429) },
    },
  },
  '/v1/store/quotations/{token}': {
    get: {
      tags: ['Store'],
      summary: 'A quotation (its page)',
      description: 'status: open, expired (open but past its date), ordered (with the order), cancelled. Personal: never cached.',
      requestParams: { path: token },
      responses: { '200': { description: 'The quotation' }, ...errors(404) },
    },
  },
  '/v1/store/quotations/{token}/total': {
    post: {
      tags: ['Store'],
      summary: 'Delivery and total for ordering it to a place',
      description: 'The quoted items plus the delivery charge for the place (worked out as the order will be), the advance for wholesale, and the minimum order.',
      requestParams: { path: token },
      requestBody: jsonBody(quotationPlaceBody),
      responses: { '200': json(z.object({ deliveryFee: z.number().nullable(), total: z.number().nullable(), advance: z.number(), minOrderAmount: z.number().nullable() })), ...errors(400, 404) },
    },
  },
  '/v1/store/quotations/{token}/order': {
    post: {
      tags: ['Store'],
      summary: 'Order the quotation at its prices',
      description:
        'Prices and quantities come from the saved quotation only; no coupons or further discounts; delivery worked out now; stock checked. ' +
        'Ordered at most once (the quotation is locked and marked ordered with the order). 409 PRICE_CHANGED: expectedTotal differs; 409: already ordered; ' +
        '410 EXPIRED; 400: cancelled, a product no longer for sale, not enough stock, or a wholesale quotation whose business is no longer approved. ' +
        'The same requestId again returns the same order.',
      requestParams: { path: token },
      requestBody: jsonBody(quotationOrderBody),
      responses: { '201': json(placed, 'Placed'), '200': json(placed, 'Already placed with this requestId'), '410': { description: 'Expired' }, ...errors(400, 403, 404, 409, 429) },
    },
  },
  '/v1/admin/quotations': {
    get: {
      tags: adminTags,
      security: adminAuth,
      summary: 'List quotations',
      description: `${access} Newest first, 50 per page, with counts per status (open, expired, ordered, cancelled) for the same search.`,
      requestParams: { query: quotationListQuery },
      responses: { '200': { description: 'Quotations' }, ...errors(401, 403) },
    },
  },
  '/v1/admin/quotations/{id}': {
    get: {
      tags: adminTags,
      security: adminAuth,
      summary: 'A quotation',
      description: `${access} Its lines at their fixed prices, the link to its page on the website, and the order once ordered.`,
      requestParams: { path: idParam },
      responses: { '200': { description: 'The quotation' }, ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/quotations/{id}/cancel': {
    post: {
      tags: adminTags,
      security: adminAuth,
      summary: 'Cancel an open quotation',
      description: `${access} It can no longer be ordered. An ordered or cancelled one answers 400.`,
      requestParams: { path: idParam },
      responses: { '200': { description: 'The quotation' }, ...errors(400, 401, 403, 404) },
    },
  },
};
