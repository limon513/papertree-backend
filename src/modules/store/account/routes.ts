import { randomInt, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isProduction } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { customerLoginCodes, customers, customerSessions, orderItems, orders } from '../../../db/schema/index.ts';
import { sha256 } from '../../../lib/crypto.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../../lib/errors.ts';
import { getIntegration, sendSms } from '../../admin/integrations/service.ts';
import { getSettings } from '../../admin/settings/service.ts';
import { imagesById } from '../catalog.ts';
import { orderView } from '../orders.ts';
import { googleTicket, readGoogleTicket, verifyGoogleToken, type GoogleUser } from './google.ts';
import { codeBody, googleBody, verifyBody } from './schemas.ts';
import { currentCustomer, customerView, signIn, signOut } from './session.ts';

/** Website sign-in (phone code or Google) and the shopper's own account. Mounted at /v1/store. */
export const accountRouter = Router();

const CODE_MINUTES = 5;
const MAX_TRIES = 5;
const RESEND_SECONDS = 60;
const CODES_PER_HOUR = 5;

const limited = (message: string) => ({ error: { code: 'TOO_MANY_REQUESTS', message } });
/** Per connection. Many phones share one mobile network address, so these are generous: the per-number limits do the real work. */
const codeLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: limited('Too many codes asked from this connection. Please try again later.') });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: limited('Too many tries. Please wait a few minutes.') });

const tooMany = (message: string) => new AppError(429, 'TOO_MANY_REQUESTS', message);
const codeHash = (phone: string, code: string) => sha256(`${phone}:${code}`);
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const blockedMessage = 'This account cannot sign in on the website. Please call us.';

// ---- Phone code ----

/** Sends a 6-digit code by SMS. A new code replaces the old one. */
accountRouter.post('/auth/code', codeLimiter, async (req, res) => {
  const { phone } = codeBody.parse(req.body);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const recent = await db
    .select({ createdAt: customerLoginCodes.createdAt })
    .from(customerLoginCodes)
    .where(and(eq(customerLoginCodes.phone, phone), gt(customerLoginCodes.createdAt, hourAgo)))
    .orderBy(desc(customerLoginCodes.createdAt));
  const wait = recent[0] ? RESEND_SECONDS - Math.floor((Date.now() - recent[0].createdAt.getTime()) / 1000) : 0;
  if (wait > 0) throw tooMany(`Please wait ${wait} seconds before asking for a new code.`);
  if (recent.length >= CODES_PER_HOUR) throw tooMany('Too many codes for this number. Please try again in an hour, or call us.');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.transaction(async (tx) => {
    await tx.update(customerLoginCodes).set({ usedAt: new Date() }).where(and(eq(customerLoginCodes.phone, phone), isNull(customerLoginCodes.usedAt)));
    await tx.insert(customerLoginCodes).values({ phone, codeHash: codeHash(phone, code), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000), ip: req.ip ?? null });
  });
  const store = await getSettings('store');
  await sendSms({
    to: phone,
    text: `${code} is your ${store.name} code. It works for ${CODE_MINUTES} minutes. Do not share it with anyone.`,
    logText: `•••••• is your ${store.name} code.`,
    purpose: 'login.code',
  });
  // On a developer's computer the code is shown on the page (SMS is not sent from there).
  res.json({ sent: true, seconds: RESEND_SECONDS, ...(!isProduction && { devCode: code }) });
});

/**
 * Checks the code and signs in. A new number also needs a name: the first answer is then
 * { needsName: true } (the code stays valid), and the site sends the code again with the name.
 */
accountRouter.post('/auth/verify', verifyLimiter, async (req, res) => {
  const body = verifyBody.parse(req.body);
  const google = body.googleTicket ? readGoogleTicket(body.googleTicket) : null;
  const [row] = await db
    .select()
    .from(customerLoginCodes)
    .where(and(eq(customerLoginCodes.phone, body.phone), isNull(customerLoginCodes.usedAt), gt(customerLoginCodes.expiresAt, new Date())))
    .orderBy(desc(customerLoginCodes.createdAt))
    .limit(1);
  if (!row || row.attempts >= MAX_TRIES) throw badRequest('This code has expired. Ask for a new one.', { code: 'Ask for a new code' });
  if (!sameHash(row.codeHash, codeHash(body.phone, body.code))) {
    await db.update(customerLoginCodes).set({ attempts: sql`${customerLoginCodes.attempts} + 1` }).where(eq(customerLoginCodes.id, row.id));
    const left = MAX_TRIES - row.attempts - 1;
    throw badRequest(left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.', { code: 'Wrong code' });
  }

  const [found] = await db.select().from(customers).where(eq(customers.phone, body.phone));
  if (found?.isBlocked) throw forbidden(blockedMessage);
  const name = body.name ?? google?.name ?? null;
  if (!found && !name) {
    res.json({ needsName: true });
    return;
  }
  // Used: it can never work again.
  const [used] = await db
    .update(customerLoginCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(customerLoginCodes.id, row.id), isNull(customerLoginCodes.usedAt)))
    .returning({ id: customerLoginCodes.id });
  if (!used) throw badRequest('This code was just used. Ask for a new one.');

  const customerId = found ? await linkGoogle(found, google) : await newCustomer(body.phone, name!, google);
  // The phone is now confirmed: anyone signed in only by placing an order with this number is signed out.
  await db.delete(customerSessions).where(and(eq(customerSessions.customerId, customerId), eq(customerSessions.via, 'order')));
  await signIn(res, req, customerId, google ? 'google' : 'code');
  res.json({ customer: await viewOf(customerId) });
});

async function newCustomer(phone: string, name: string, google: GoogleUser | null) {
  if (google) await googleFree(google.uid, null);
  const [created] = await db
    .insert(customers)
    .values({ name, phone, email: google?.email ?? null, googleId: google?.uid ?? null, avatarUrl: google?.picture ?? null })
    .returning({ id: customers.id });
  return created!.id;
}

/** Adds the Google account to an existing customer (from a first Google sign-in). */
async function linkGoogle(c: typeof customers.$inferSelect, google: GoogleUser | null) {
  if (!google) return c.id;
  if (c.googleId && c.googleId !== google.uid) throw conflict('This number is already linked to another Google account. Sign in with that one, or with your number only.');
  await googleFree(google.uid, c.id);
  await db
    .update(customers)
    .set({ googleId: google.uid, avatarUrl: google.picture ?? c.avatarUrl, ...(!c.email && google.email && { email: google.email }) })
    .where(eq(customers.id, c.id));
  return c.id;
}

/** One Google account, one customer. */
async function googleFree(uid: string, customerId: number | null) {
  const [other] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(customerId ? and(eq(customers.googleId, uid), ne(customers.id, customerId)) : eq(customers.googleId, uid));
  if (other) throw conflict('This Google account is already linked to another phone number. Sign in with Google directly.');
}

// ---- Google ----

/**
 * Sign in with Google. A Google account seen before signs straight in. A new one must add a phone
 * number once (confirmed with a code): the answer is then { needsPhone: true, ticket }. We never
 * match by email alone: an email typed at checkout is not proof that the account is theirs.
 */
accountRouter.post('/auth/google', verifyLimiter, async (req, res) => {
  const { idToken } = googleBody.parse(req.body);
  const { settings } = await getIntegration('google');
  if (!settings.enabled || !settings.projectId) throw badRequest('Google sign-in is not switched on.');
  const google = await verifyGoogleToken(idToken, settings.projectId);
  const [found] = await db.select().from(customers).where(eq(customers.googleId, google.uid));
  if (found) {
    if (found.isBlocked) throw forbidden(blockedMessage);
    // Their current photo (people change it).
    if (google.picture !== found.avatarUrl) await db.update(customers).set({ avatarUrl: google.picture }).where(eq(customers.id, found.id));
    await signIn(res, req, found.id, 'google');
    res.json({ customer: await viewOf(found.id) });
    return;
  }
  res.json({ needsPhone: true, ticket: googleTicket(google), name: google.name, avatarUrl: google.picture });
});

accountRouter.post('/auth/logout', async (req, res) => {
  await signOut(req, res);
  res.json({ ok: true });
});

// ---- The shopper's account ----

async function viewOf(customerId: number) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  return customerView(c!);
}

async function signedIn(req: Request) {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in');
  return c;
}

/** Who is signed in: { customer } or { customer: null }. Never cached. */
accountRouter.get('/me', async (req, res) => {
  const c = await currentCustomer(req);
  res.set('cache-control', 'no-store').json({ customer: c ? await customerView(c) : null });
});

/** The shopper's orders, newest first (website and those taken by phone or in the shop). */
accountRouter.get('/me/orders', async (req, res) => {
  const c = await signedIn(req);
  const page = z.coerce.number().int().min(1).max(100).catch(1).parse(req.query.page);
  const perPage = 20;
  const where = eq(orders.customerId, c.id);
  const [rows, [total]] = await Promise.all([
    db
      .select({ id: orders.id, number: orders.number, status: orders.status, createdAt: orders.createdAt, total: orders.total, channel: orders.channel })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage),
    db.select({ n: count() }).from(orders).where(where),
  ]);
  const items = rows.length
    ? await db
        .select({ orderId: orderItems.orderId, name: orderItems.name, quantity: orderItems.quantity, imageId: orderItems.imageId, position: orderItems.position })
        .from(orderItems)
        .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
        .orderBy(orderItems.position)
    : [];
  const images = await imagesById(items.map((i) => i.imageId));
  res.set('cache-control', 'no-store').json({
    orders: rows.map((o) => {
      const mine = items.filter((i) => i.orderId === o.id);
      return {
        number: o.number,
        status: o.status,
        createdAt: o.createdAt,
        total: o.total,
        itemCount: mine.reduce((n, i) => n + i.quantity, 0),
        names: mine.slice(0, 3).map((i) => i.name),
        images: mine.slice(0, 4).map((i) => (i.imageId ? (images.get(i.imageId) ?? null) : null)),
      };
    }),
    total: total!.n,
    page,
    pages: Math.max(1, Math.ceil(total!.n / perPage)),
  });
});

/** One of the shopper's orders. */
accountRouter.get('/me/orders/:number', async (req, res) => {
  const c = await signedIn(req);
  const number = Number(req.params.number);
  if (!Number.isInteger(number)) throw notFound('Order not found');
  const view = await orderView(and(eq(orders.number, number), eq(orders.customerId, c.id))!);
  if (!view) throw notFound('Order not found');
  res.set('cache-control', 'no-store').json(view);
});
