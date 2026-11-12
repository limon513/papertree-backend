import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { couponBody, couponListQuery } from './schemas.ts';

const tags = ['Admin: Coupons'];
const security = adminAuth;
const access =
  'Needs the Marketing section. One coupon per order, retail only. percent (0.5–90%, optional cap), fixed (whole taka) or free_delivery. ' +
  'Works on item prices after bulk discounts (withBulk: false leaves out lines with a bulk discount; onSaleItems: false leaves out sale items). ' +
  'Every order placed with a code counts as a use, cancelled ones too. Each change is in the audit log.';
const coupon = z.object({}).catchall(z.unknown()).meta({ id: 'Coupon' });

export const couponsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/coupons': {
    get: {
      tags,
      security,
      summary: 'List coupons',
      description: `${access} Newest first, with state (live, scheduled, ended, off) and stats: orders (uses), given (taka off, not counting cancelled or returned orders) and sales.`,
      requestParams: { query: couponListQuery },
      responses: { '200': json(z.object({ items: z.array(coupon) })), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a coupon',
      description: `${access} The code is made upper case; 4–20 letters and numbers.`,
      requestBody: jsonBody(couponBody),
      responses: { '201': json(coupon, 'Added'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/coupons/{id}': {
    get: { tags, security, summary: 'One coupon, with its last 50 orders', description: access, requestParams: { path: idParam }, responses: { '200': json(coupon), ...errors(401, 403, 404) } },
    put: {
      tags,
      security,
      summary: 'Change a coupon',
      description: `${access} A coupon that was used keeps its code.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(couponBody),
      responses: { '200': json(coupon), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a coupon never used',
      description: `${access} A used coupon cannot be deleted (its orders keep it): switch it off instead.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/coupons/{id}/active': {
    post: {
      tags,
      security,
      summary: 'Switch a coupon on or off',
      description: access,
      requestParams: { path: idParam },
      requestBody: jsonBody(z.object({ active: z.boolean() })),
      responses: { '200': json(coupon), ...errors(401, 403, 404) },
    },
  },
};
