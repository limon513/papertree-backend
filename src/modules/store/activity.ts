import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { customerActivity, customerLoginAsTokens, customers, products } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { actingStaff, currentCustomer } from './account/session.ts';

/**
 * What signed-in customers do on the website, for staff to understand them: visits (and the device),
 * products looked at, searches. Never guests, never while staff are logged in as the customer.
 * The same thing again within 30 minutes counts once. Kept 90 days.
 */
export const activityRouter = Router();

export const ACTIVITY_DAYS = 90;
const AGAIN_AFTER = 30 * 60_000;

/** "Phone · Chrome", "Computer · Edge": enough to tell devices apart, nothing more. */
export function deviceOf(userAgent: string | undefined) {
  const ua = userAgent ?? '';
  const kind = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/.test(ua) ? 'Phone' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${kind} · ${browser}`;
}

/** The customer whose activity this is, or null (a guest, or staff logged in as them). */
export async function whose(req: Request) {
  const c = await currentCustomer(req);
  if (!c || (await actingStaff(req))) return null;
  return c;
}

/** Records one thing, unless the same was recorded in the last 30 minutes. Never throws. */
async function record(req: Request, kind: 'visit' | 'product' | 'search', data: { productId?: number; query?: string } = {}) {
  try {
    const c = await whose(req);
    if (!c) return false;
    const since = new Date(Date.now() - AGAIN_AFTER);
    const [same] = await db
      .select({ id: customerActivity.id })
      .from(customerActivity)
      .where(
        and(
          eq(customerActivity.customerId, c.id),
          eq(customerActivity.kind, kind),
          gt(customerActivity.createdAt, since),
          kind === 'product' ? eq(customerActivity.productId, data.productId!) : undefined,
          kind === 'search' ? eq(customerActivity.query, data.query!) : undefined,
        ),
      )
      .orderBy(desc(customerActivity.id))
      .limit(1);
    if (kind === 'visit') await db.update(customers).set({ lastSeenAt: new Date() }).where(eq(customers.id, c.id));
    if (same) return false;
    await db.insert(customerActivity).values({ customerId: c.id, kind, productId: data.productId ?? null, query: data.query ?? null, device: deviceOf(req.get('user-agent')) });
    return true;
  } catch (err) {
    logger.warn({ err }, 'Could not record customer activity');
    return false;
  }
}

/** A search made by a signed-in customer (called by the search report's own logging). */
export const recordSearch = (req: Request, query: string) => record(req, 'search', { query: query.slice(0, 100) });

const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const body = z.discriminatedUnion('kind', [z.object({ kind: z.literal('visit') }), z.object({ kind: z.literal('product'), productId: z.number().int().positive() })]);

/** The website reports a visit (once in a while) or a product page seen. Answers nothing. */
activityRouter.post('/activity', limiter, async (req, res) => {
  const input = body.safeParse(req.body);
  if (input.success) {
    if (input.data.kind === 'product') {
      const [p] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, input.data.productId), eq(products.status, 'active')));
      if (p) await record(req, 'product', { productId: p.id });
    } else await record(req, 'visit');
  }
  res.status(204).end();
});

/** Activity older than 90 days, and old one-time login links, go (a daily job). */
export async function cleanUpActivity() {
  const old = new Date(Date.now() - ACTIVITY_DAYS * 86_400_000);
  const gone = await db.delete(customerActivity).where(lt(customerActivity.createdAt, old)).returning({ id: customerActivity.id });
  await db.delete(customerLoginAsTokens).where(lt(customerLoginAsTokens.expiresAt, new Date(Date.now() - 86_400_000)));
  logger.info({ removed: gone.length }, 'Old customer activity removed');
  return gone.length;
}
