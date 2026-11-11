import type { Request, Response } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import { isProduction } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { customers, customerSessions } from '../../../db/schema/index.ts';
import { randomToken, sha256 } from '../../../lib/crypto.ts';
import { addressesOf, addressView } from '../../admin/customers/service.ts';

/**
 * Website sign-in sessions, like the admin's: a random token in an httpOnly cookie, only its hash in
 * the database (so a database leak signs no one in), renewed while used, removable any time.
 */
export const CUSTOMER_COOKIE = 'pt_customer';
const DAY = 24 * 60 * 60 * 1000;
/** Shoppers stay signed in for 60 days of not visiting; each visit extends it. */
const LIFETIME = 60 * DAY;
const RENEW_WHEN_LESS_THAN = 50 * DAY;

export type SignInVia = 'code' | 'google' | 'order';

export async function signIn(res: Response, req: Request, customerId: number, via: SignInVia) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + LIFETIME);
  await db.insert(customerSessions).values({
    id: sha256(token),
    customerId,
    via,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    expiresAt,
  });
  await db.update(customers).set({ lastSignInAt: new Date() }).where(eq(customers.id, customerId));
  res.cookie(CUSTOMER_COOKIE, token, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', expires: expiresAt });
}

/** Signs out this browser, or (`everywhere`) every device signed in to this account. */
export async function signOut(req: Request, res: Response, everywhere = false) {
  const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
  if (token && everywhere) {
    const [s] = await db.select({ customerId: customerSessions.customerId }).from(customerSessions).where(eq(customerSessions.id, sha256(token)));
    if (s) await db.delete(customerSessions).where(eq(customerSessions.customerId, s.customerId));
  } else if (token) {
    await db.delete(customerSessions).where(eq(customerSessions.id, sha256(token)));
  }
  res.clearCookie(CUSTOMER_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}

/** The signed-in customer of this request, or null. Blocked customers count as signed out. */
export async function currentCustomer(req: Request) {
  const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
  if (!token) return null;
  const id = sha256(token);
  const now = new Date();
  const [row] = await db
    .select({ session: customerSessions, customer: customers })
    .from(customerSessions)
    .innerJoin(customers, eq(customers.id, customerSessions.customerId))
    .where(and(eq(customerSessions.id, id), gt(customerSessions.expiresAt, now)))
    .limit(1);
  if (!row || row.customer.isBlocked) return null;
  if (row.session.expiresAt.getTime() - now.getTime() < RENEW_WHEN_LESS_THAN) {
    await db.update(customerSessions).set({ expiresAt: new Date(now.getTime() + LIFETIME), lastUsedAt: now }).where(eq(customerSessions.id, id));
  }
  return row.customer;
}

/** What the website knows about the signed-in customer. */
export async function customerView(c: typeof customers.$inferSelect) {
  // The default first, then the latest used.
  const addresses = (await addressesOf(c.id)).map(addressView);
  const best = addresses[0];
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    avatarUrl: c.avatarUrl,
    google: !!c.googleId,
    business: c.type === 'business' && c.businessStatus === 'approved',
    /** The one checkout fills in. */
    address: best ? { districtId: best.districtId, areaId: best.areaId, address: best.address } : null,
    addresses,
  };
}
