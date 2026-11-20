import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { getIntegration, stateOf } from '../admin/integrations/service.ts';
import { unauthorized } from '../../lib/errors.ts';
import { preferencesOf, registerDevice, removeDevice, setPreferences } from '../push/service.ts';
import { countTap } from '../push/campaigns.ts';
import { actingStaff, currentCustomer } from './account/session.ts';

/** Push notifications on the website: devices that allowed them, and what the customer wants. */
export const pushRouter = Router();

/**
 * The Firebase web settings the website needs to turn alerts on (public by design, like the sign-in
 * ones), or null when push is off or not set up.
 */
export async function pushWebConfig() {
  const [push, google] = await Promise.all([getIntegration('push'), getIntegration('google')]);
  const state = stateOf('push', push);
  const g = google.settings;
  if (state === 'off' || state === 'incomplete' || !(g.apiKey && g.projectId && g.appId)) return null;
  return { apiKey: g.apiKey, authDomain: g.authDomain, projectId: g.projectId, appId: g.appId, messagingSenderId: push.settings.senderId, vapidKey: push.settings.vapidKey };
}

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

const deviceBody = z.object({
  token: z.string().trim().min(20).max(4096),
  device: z.string().trim().max(80).nullable().default(null),
});

/** This browser allowed alerts: its token (a signed-in shopper's device becomes theirs). */
pushRouter.post('/push/devices', limiter, async (req, res) => {
  const { token, device } = deviceBody.parse(req.body);
  const c = await currentCustomer(req);
  // Staff logged in as a customer: their browser must never get the customer's alerts.
  const mine = c && !(await actingStaff(req)) ? c.id : null;
  await registerDevice(token, device, mine);
  res.status(204).end();
});

/** This browser turned alerts off. */
pushRouter.post('/push/devices/remove', limiter, async (req, res) => {
  const { token } = deviceBody.pick({ token: true }).parse(req.body);
  await removeDevice(token);
  res.status(204).end();
});

/** A tap on an offer (sent by the device's service worker; only a count, nothing personal). */
const tapLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
pushRouter.post('/push/tapped', tapLimiter, async (req, res) => {
  const id = Number(req.query.c);
  if (Number.isInteger(id) && id > 0) await countTap(id);
  res.status(204).end();
});

const prefsBody = z.object({ orders: z.boolean().optional(), offers: z.boolean().optional(), wishlist: z.boolean().optional() });

/** Which alerts they want, and on how many devices they allowed them. */
pushRouter.get('/me/notifications', async (req, res) => {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in');
  res.set('cache-control', 'no-store').json(await preferencesOf(c.id));
});

pushRouter.patch('/me/notifications', async (req, res) => {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in');
  res.json(await setPreferences(c.id, prefsBody.parse(req.body)));
});
