import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { BUSINESS_TYPES, customers, type BusinessType } from '../../../db/schema/index.ts';
import { conflict } from '../../../lib/errors.ts';
import { logger } from '../../../lib/logger.ts';
import { getIntegration, sendEmail, sendSms } from '../../admin/integrations/service.ts';
import { optionalText } from '../../admin/schemas.ts';
import { getSettings } from '../../admin/settings/service.ts';
import { smsSafe } from '../order-updates.ts';
import { esc } from '../order-emails.ts';

/**
 * Business (wholesale) accounts from the website: a signed-in customer asks, staff call and approve
 * in the admin (Customers), and from then on the account buys at wholesale prices.
 */

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  shop: 'Shop or reseller',
  school: 'School, college or coaching centre',
  office: 'Office or company',
  other: 'Other',
};

export const businessApplyBody = z
  .object({
    businessName: z
      .string({ error: 'Enter the business name' })
      .trim()
      .min(2, { error: 'Enter the business name' })
      .max(150, { error: 'The name is too long' }),
    businessType: z.enum(BUSINESS_TYPES, { error: 'Choose what kind of business' }),
    address: z
      .string({ error: 'Enter the business address' })
      .trim()
      .min(5, { error: 'Enter the business address' })
      .max(500, { error: 'The address is too long' }),
    tradeLicense: optionalText(60).default(null).meta({ description: 'Trade licence number (optional)' }),
  })
  .meta({ id: 'StoreBusinessApplyBody' });

type Customer = typeof customers.$inferSelect;

/** The business part of the account, for the website. */
export const businessView = (c: Customer) =>
  c.businessStatus
    ? {
        status: c.businessStatus,
        businessName: c.businessName,
        businessType: c.businessType,
        appliedAt: c.businessAppliedAt,
      }
    : null;

/** A customer asks for a business account. Again after a "no" is fine; staff decide again. */
export async function applyForBusiness(c: Customer, input: z.infer<typeof businessApplyBody>) {
  if (c.type === 'business' && c.businessStatus === 'approved') throw conflict('Your business account is already approved.');
  if (c.businessStatus === 'pending') throw conflict('We already have your request. We will call you soon.');
  const [row] = await db
    .update(customers)
    .set({
      type: 'business',
      businessStatus: 'pending',
      businessName: input.businessName,
      businessType: input.businessType,
      businessAddress: input.address,
      tradeLicense: input.tradeLicense ?? c.tradeLicense,
      businessAppliedAt: new Date(),
    })
    .where(eq(customers.id, c.id))
    .returning();
  // The shop hears about it by email (never holds up the answer).
  void alertShop(row!).catch((err) => logger.error({ err, customer: c.id }, 'Could not send the business request alert'));
  return row!;
}

async function alertShop(c: Customer) {
  const { settings } = await getIntegration('email');
  if (!settings.staffEmail) return;
  const link = `${env.ADMIN_APP_URL.replace(/\/$/, '')}/customers/${c.id}`;
  const lines: [string, string | null][] = [
    ['Business', c.businessName],
    ['Kind', c.businessType ? BUSINESS_TYPE_LABEL[c.businessType] : null],
    ['Address', c.businessAddress],
    ['Trade licence', c.tradeLicense],
    ['Contact', `${c.name}, ${c.phone}${c.email ? `, ${c.email}` : ''}`],
  ];
  const shown = lines.filter(([, v]) => v);
  await sendEmail({
    to: settings.staffEmail,
    subject: `Wholesale request: ${c.businessName}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#18181b">
<h2 style="margin:0 0 12px">New wholesale request</h2>
<table cellpadding="0" cellspacing="0">${shown.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#71717a">${k}</td><td style="padding:3px 0">${esc(v!)}</td></tr>`).join('')}</table>
<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:999px">Open the customer</a></p>
<p style="color:#71717a;font-size:13px">Call them, then approve or reject the request on the customer page.</p></div>`,
    text: ['New wholesale request', '', ...shown.map(([k, v]) => `${k}: ${v}`), '', `Open the customer: ${link}`].join('\n'),
    purpose: `business.request #${c.id}`,
  });
}

/** Tells a business it was approved (Settings → Customer messages chooses SMS / email). */
export async function tellApproved(c: Customer) {
  const [messages, store] = await Promise.all([getSettings('messages'), getSettings('store')]);
  const choice = messages.businessApproved;
  const site = env.STOREFRONT_URL.replace(/\/$/, '');
  const purpose = `business.approved #${c.id}`;
  if (choice.sms) {
    await sendSms({ to: c.phone, text: approvedSms(store.name), purpose });
  }
  if (choice.email && c.email) {
    const name = c.businessName ?? c.name;
    await sendEmail({
      to: c.email,
      subject: `${name}: your business account is approved`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#18181b;max-width:520px">
<h2 style="margin:0 0 12px">Your business account is approved</h2>
<p>Thank you, ${esc(c.name.split(' ')[0] ?? c.name)}. <strong>${esc(name)}</strong> can now buy at wholesale prices on ${esc(store.name)}.</p>
<p>Sign in on the website with ${esc(c.phone)} to see them.</p>
<p style="margin:20px 0"><a href="${esc(site)}/account/" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Start shopping</a></p>
${store.phone ? `<p style="color:#71717a;font-size:13px">Questions? Call ${esc(store.phone)}.</p>` : ''}</div>`,
      text: `Your business account is approved.\n\n${name} can now buy at wholesale prices on ${store.name}. Sign in on the website with ${c.phone} to see them.\n\n${site}/account/`,
      purpose,
    });
  }
}

export const approvedSms = (storeName: string) =>
  `${smsSafe(storeName) || 'PaperTree'}: Your business account is approved. Sign in on our website to see wholesale prices.`;
