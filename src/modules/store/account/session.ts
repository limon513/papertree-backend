import type { Request, Response } from 'express';
import { and, desc, eq, gt } from 'drizzle-orm';
import { isProduction } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { customerAddresses, customers, customerSessions } from '../../../db/schema/index.ts';
import { randomToken, sha256 } from '../../../lib/crypto.ts';

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

export async function signOut(req: Request, res: Response) {
  const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
  if (token) await db.delete(customerSessions).where(eq(customerSessions.id, sha256(token)));
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
  // The default address, else the latest used.
  const [best] = await db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, c.id))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.updatedAt))
    .limit(1);
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    avatarUrl: c.avatarUrl,
    google: !!c.googleId,
    business: c.type === 'business' && c.businessStatus === 'approved',
    address: best ? { districtId: best.districtId, areaId: best.areaId, address: best.address } : null,
  };
}
