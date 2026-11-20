import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { customers } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest } from '../../../lib/errors.ts';
import { isBdPhone, normalizePhone } from '../../../lib/phone.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { audienceSize, campaignList, cancelCampaign, createCampaign, MIN_GAP_HOURS, QUIET_FROM, QUIET_UNTIL, sendTest } from '../../push/campaigns.ts';

/** Push offers and news (Marketing). Mounted behind requireAdmin + requireModule('marketing'). */
export const pushCampaignsRouter = Router();

const site = () => new URL(env.STOREFRONT_URL);

/** A page on the shop's website: "/deals/" or the full address. */
const siteLink = z
  .string()
  .trim()
  .min(1, { error: 'Where should a tap open?' })
  .max(500)
  .transform((v, ctx) => {
    if (v.startsWith('/') && !v.startsWith('//')) return v;
    try {
      const u = new URL(v);
      if (u.host === site().host) return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      // not an address
    }
    ctx.addIssue({ code: 'custom', message: 'A page on your website, like /deals/ or a full address of the shop' });
    return z.NEVER;
  });

export const campaignBody = z
  .object({
    title: z.string().trim().min(3, { error: 'Write a short title' }).max(65, { error: 'At most 65 letters: phones cut longer titles' }),
    body: z.string().trim().min(5, { error: 'Write the message' }).max(180, { error: 'At most 180 letters: keep it short' }),
    url: siteLink,
    imageId: z.number().int().positive().nullable().default(null),
    /** null: as soon as allowed. */
    sendAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .meta({ id: 'PushCampaignBody' });

export const testBody = campaignBody.omit({ sendAt: true }).extend({ phone: z.string().trim().min(10).max(20) });

/** Offers sent and planned, how many devices one would reach now, and the rules. */
pushCampaignsRouter.get('/', async (_req, res) => {
  const [items, audience] = await Promise.all([campaignList(), audienceSize()]);
  res.json({ items, audience, rules: { quietFrom: QUIET_FROM, quietUntil: QUIET_UNTIL, minGapHours: MIN_GAP_HOURS } });
});

/** Send an offer now (or at a time). Night hours and the gap between offers are kept. */
pushCampaignsRouter.post('/', async (req, res) => {
  const input = campaignBody.parse(req.body);
  const row = await createCampaign({ ...input, sendAt: input.sendAt ? new Date(input.sendAt) : null }, currentAdmin(req).id);
  await audit(req, { action: 'push.campaign', entityType: 'push_campaign', entityId: String(row.id), after: { title: row.title, sendAt: row.sendAt } });
  res.status(201).json(row);
});

/** Try it on one customer's phone first (the devices of that phone number). */
pushCampaignsRouter.post('/test', async (req, res) => {
  const { phone: raw, ...input } = testBody.parse(req.body);
  const phone = normalizePhone(raw);
  if (!isBdPhone(phone)) throw badRequest('Enter a Bangladeshi number', { phone: 'Like 01712345678' });
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.phone, phone));
  if (!c) throw badRequest('No customer with this number', { phone: 'Sign in on the website with this number and turn on alerts first' });
  res.json(await sendTest(input, c.id));
});

pushCampaignsRouter.post('/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Not an offer');
  const row = await cancelCampaign(id);
  await audit(req, { action: 'push.campaign.cancel', entityType: 'push_campaign', entityId: String(id), after: { title: row.title } });
  res.json(row);
});
