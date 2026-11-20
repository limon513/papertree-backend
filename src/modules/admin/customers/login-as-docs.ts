import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json } from '../../../docs/common.ts';

/** Login as customer, and customer activity. */
export const loginAsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/login-as/{customerId}': {
    post: {
      tags: ['Admin: Customers'],
      security: adminAuth,
      summary: 'A one-time link to log in as the customer on the website',
      description:
        'Needs a role allowed to "Log in as customer" (Roles page; Super Admins always). The link (token in the # part) works once, for 2 minutes; ' +
        'it logs that browser in as the customer for 30 minutes, never renewed, with a banner. Orders placed are marked with the staff member. ' +
        'Reviews, push alerts and "sign out everywhere" are not done for the customer. Each link is in the audit log.',
      requestParams: { path: z.object({ customerId: z.coerce.number() }) },
      responses: { '200': json(z.object({ url: z.string(), expiresInSeconds: z.number() })), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/customers/{id}/activity': {
    get: {
      tags: ['Admin: Customers'],
      security: adminAuth,
      summary: "A customer's website activity (90 days)",
      description: 'Needs the Customers section. Visits (30/90 days) and devices, products looked at, searches, favourite categories, staff who logged in as them.',
      requestParams: { path: idParam },
      responses: { '200': { description: 'Activity' }, ...errors(401, 403, 404) },
    },
  },
  '/v1/store/auth/as': {
    post: {
      tags: ['Store'],
      summary: "Use a staff member's one-time link (log in as the customer)",
      description: 'Sets the sign-in cookie for 30 minutes, marked as staff. 400 when the link expired or was used.',
      requestBody: { content: { 'application/json': { schema: z.object({ token: z.string() }) } } },
      responses: { '200': { description: '{ customer }' }, ...errors(400, 429) },
    },
  },
  '/v1/store/activity': {
    post: {
      tags: ['Store'],
      summary: 'Report a visit or a product page seen (signed-in customers)',
      description: 'kind=visit, or kind=product with productId. Guests and staff logged in as a customer are not recorded; the same thing within 30 minutes counts once. Kept 90 days.',
      requestBody: { content: { 'application/json': { schema: z.object({ kind: z.enum(['visit', 'product']), productId: z.number().optional() }) } } },
      responses: { '204': { description: 'Noted (or ignored)' } },
    },
  },
};
