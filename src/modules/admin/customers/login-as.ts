import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { env } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { customerLoginAsTokens, customers } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { randomToken, sha256 } from '../../../lib/crypto.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';

/**
 * "Log in as customer": a one-time link (2 minutes) that logs this staff member in as the customer on
 * the website, for 30 minutes, clearly marked. Mounted behind requireAdmin + requireModule('login_as').
 */
export const loginAsRouter = Router();

const LINK_MINUTES = 2;

loginAsRouter.post('/:customerId', async (req, res) => {
  const customerId = parseId(req.params.customerId);
  const admin = currentAdmin(req);
  const [c] = await db.select({ id: customers.id, name: customers.name, isBlocked: customers.isBlocked }).from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound('Customer not found');
  if (c.isBlocked) throw badRequest('This customer is blocked: unblock them first.');
  const token = randomToken();
  await db.insert(customerLoginAsTokens).values({ id: sha256(token), customerId, adminUserId: admin.id, expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) });
  await audit(req, { action: 'customer.login_as', entityType: 'customer', entityId: customerId, after: { customer: c.name } });
  // The token rides in the fragment (#): it never reaches a server log or a Referer header.
  res.json({ url: `${env.STOREFRONT_URL.replace(/\/$/, '')}/account/as/#${token}`, expiresInSeconds: LINK_MINUTES * 60 });
});
