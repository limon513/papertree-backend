import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { onlinePayments, orders } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { steadfastEvent, webhookAllowed } from '../admin/orders/steadfast.ts';
import { markUnpaid, settle } from '../payments/service.ts';

/**
 * Calls from outside services. Each checks its own secret. Bodies are kept raw here (mounted before
 * the JSON parser), because signatures are computed on the exact bytes sent.
 */
export const webhooksRouter = Router();

// Plenty for Steadfast's updates; stops anyone guessing tokens quickly.
const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });

/**
 * Steadfast events. Headers: Authorization: Bearer <token>, X-Signature: HMAC-SHA256 (hex) of the raw
 * body keyed with the token, Idempotency-Key. Steadfast waits 5 s for a 2xx; 5xx is retried after
 * 30 s and 2 min, 4xx is not. Handling the same event twice changes nothing.
 */
webhooksRouter.post('/steadfast', limiter, express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!(await webhookAllowed(req.get('authorization'), req.get('x-signature'), raw))) {
    res.status(401).json({ status: 'error', message: 'Unauthorized' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    res.status(400).json({ status: 'error', message: 'Not JSON' });
    return;
  }
  const result = await steadfastEvent(body);
  logger.info({ type: body.notification_type, consignment: body.consignment_id, status: body.status, key: req.get('idempotency-key'), result }, 'Steadfast event');
  res.status(result.found ? 200 : 404).json({ status: result.found ? 'success' : 'error', message: result.message });
});

// ---- SSLCommerz ----
// SSLCommerz sends form posts (application/x-www-form-urlencoded). Nothing in them is trusted: a
// payment counts only after SSLCommerz's validation API confirms it (payments/service.ts settle).

const form = express.urlencoded({ extended: false, limit: '64kb' });
const field = (body: unknown, name: string) => {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  return typeof v === 'string' ? v.trim().slice(0, 100) : '';
};
const PAID = new Set(['VALID', 'VALIDATED']);
const UNPAID = { FAILED: 'failed', CANCELLED: 'cancelled', EXPIRED: 'failed', UNATTEMPTED: 'failed' } as const;

/** IPN: SSLCommerz tells us about a payment, server to server (also when the shopper never came back). */
webhooksRouter.post('/sslcommerz/ipn', limiter, form, async (req, res) => {
  const tranId = field(req.body, 'tran_id');
  const status = field(req.body, 'status').toUpperCase();
  const valId = field(req.body, 'val_id');
  if (!tranId) {
    res.status(400).send('Missing tran_id');
    return;
  }
  if (PAID.has(status) && valId) {
    const r = await settle(tranId, valId, 'ipn');
    logger.info({ tranId, status, result: r.result }, 'SSLCommerz IPN');
    res.status(r.result === 'unknown' ? 404 : 200).send(r.result === 'unknown' ? 'Unknown transaction' : 'OK');
    return;
  }
  const unpaid = UNPAID[status as keyof typeof UNPAID];
  if (unpaid) await markUnpaid(tranId, unpaid, field(req.body, 'error') || status);
  logger.info({ tranId, status }, 'SSLCommerz IPN (not paid)');
  res.send('OK');
});

/**
 * The shopper's browser comes back from the payment page (SSLCommerz posts the form here): the
 * payment is checked, then they go on to their order's page on the website, which says how it went.
 */
webhooksRouter.all('/sslcommerz/return/:result', limiter, form, async (req, res) => {
  const body = { ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown> | undefined) ?? {}) };
  const tranId = field(body, 'tran_id');
  const valId = field(body, 'val_id');
  const result = String(req.params.result);
  let outcome: 'paid' | 'failed' | 'cancelled' | 'checking' = result === 'success' ? 'paid' : result === 'cancel' ? 'cancelled' : 'failed';
  let orderId: number | null = null;
  try {
    if (tranId && result === 'success' && valId) {
      const r = await settle(tranId, valId, 'return');
      orderId = r.orderId ?? null;
      if (r.result !== 'paid' && r.result !== 'already') outcome = 'checking';
    } else if (tranId && result !== 'success') {
      orderId = await markUnpaid(tranId, result === 'cancel' ? 'cancelled' : 'failed', field(body, 'error') || field(body, 'failedreason') || null);
    } else if (tranId) {
      outcome = 'checking';
    }
  } catch (err) {
    // SSLCommerz did not answer the check: the order's page asks again.
    logger.error({ err, tranId, result }, 'SSLCommerz return could not be checked');
    outcome = 'checking';
  }
  if (!orderId && tranId) {
    const [t] = await db.select({ orderId: onlinePayments.orderId }).from(onlinePayments).where(eq(onlinePayments.tranId, tranId));
    orderId = t?.orderId ?? null;
  }
  const [o] = orderId ? await db.select({ token: orders.publicToken }).from(orders).where(eq(orders.id, orderId)) : [];
  const site = env.STOREFRONT_URL.replace(/\/$/, '');
  res.redirect(303, o?.token ? `${site}/checkout/thank-you/?o=${encodeURIComponent(o.token)}&payment=${outcome}` : `${site}/`);
});
