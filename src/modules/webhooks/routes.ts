import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from '../../lib/logger.ts';
import { steadfastEvent, webhookAllowed } from '../admin/orders/steadfast.ts';

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
