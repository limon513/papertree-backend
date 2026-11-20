import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../docs/common.ts';
import { quotationListQuery, quotationSendBody, staffQuotationBody } from '../admin/quotations/routes.ts';
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
      description: `${access} Newest first, 50 per page, with counts per status (open, expired, ordered, cancelled, replaced) for the same search.`,
      requestParams: { query: quotationListQuery },
      responses: { '200': { description: 'Quotations' }, ...errors(401, 403) },
    },
    post: {
      tags: adminTags,
      security: adminAuth,
      summary: 'Make a quotation (staff)',
      description:
        `${access} Lines at the product's price (with bulk discounts, retail) or a special price per piece; valid 1–90 days; delivery fixed (0 = free) or worked out when ordering; terms shown on it. ` +
        'Linked to the chosen customer, else the customer with this phone. Wholesale only for an approved business. Below the wholesale minimum is allowed.',
      requestBody: jsonBody(staffQuotationBody),
      responses: { '201': { description: 'The quotation' }, ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/quotations/{id}/revise': {
    post: {
      tags: adminTags,
      security: adminAuth,
      summary: 'Revise a quotation (a new version)',
      description: `${access} Makes a new quotation from the body; the old one (open or expired) becomes "replaced" in the same step, so its prices can no longer be ordered. Its page points to the new one.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(staffQuotationBody),
      responses: { '201': { description: 'The new quotation' }, ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/quotations/{id}/message': {
    get: {
      tags: adminTags,
      security: adminAuth,
      summary: 'The SMS and email as the customer will get them',
      requestParams: { path: idParam },
      responses: { '200': { description: 'phone, email, sms, emailSubject, emailHtml' }, ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/quotations/{id}/send': {
    post: {
      tags: adminTags,
      security: adminAuth,
      summary: 'Send the quotation link by SMS and/or email',
      description: `${access} Only an open quotation. Each message is in the message log (test mode: only written there). Answers what happened to each and the quotation.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(quotationSendBody),
      responses: { '200': { description: 'results and quotation' }, ...errors(400, 401, 403, 404) },
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
