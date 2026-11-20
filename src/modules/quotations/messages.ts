import { desc, like } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { messageLog, quotations } from '../../db/schema/index.ts';
import { getSettings } from '../admin/settings/service.ts';
import { esc } from '../store/order-emails.ts';
import { quoteNumber } from './service.ts';

/** A quotation's page on the website (the link sent to the customer). */
export const quotationLink = (token: string) => `${env.STOREFRONT_URL.replace(/\/$/, '')}/quotation/${token}/`;

const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const day = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' }).format(d);

type Q = typeof quotations.$inferSelect;

/** The SMS: short, with the link (one or two SMS parts). */
export async function quotationSms(q: Q) {
  const store = await getSettings('store');
  return `${store.name}: your quotation ${quoteNumber(q.number)} for ${taka(q.subtotal)} is ready, valid till ${day(q.validUntil)}. See it and order: ${quotationLink(q.publicToken)}`;
}

/** The email: who it is for, the total, the date, a button to the quotation page. */
export async function quotationEmail(q: Q) {
  const store = await getSettings('store');
  const no = quoteNumber(q.number);
  const link = quotationLink(q.publicToken);
  const delivery = q.deliveryFee === null ? 'Delivery is worked out when you order.' : q.deliveryFee === 0 ? 'Delivery is free.' : `Delivery: ${taka(q.deliveryFee)}.`;
  const subject = `Your quotation ${no} from ${store.name}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;padding:24px">
<h1 style="margin:0 0 8px;font-size:22px">Your quotation ${esc(no)}</h1>
<p style="margin:0 0 8px;line-height:1.6">Dear ${esc(q.name)},</p>
<p style="margin:0 0 8px;line-height:1.6">Here is the quotation${q.organisation ? ` for ${esc(q.organisation)}` : ''} you asked for: <strong>${taka(q.subtotal)}</strong> for the items. ${esc(delivery)}</p>
<p style="margin:0 0 8px;line-height:1.6">The prices are valid until <strong>${esc(day(q.validUntil))}</strong>. You can print it, or order it online at these prices.</p>
${q.terms ? `<p style="margin:12px 0;padding:12px 14px;background:#f4f4f5;border-radius:10px;line-height:1.6">${esc(q.terms).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin:20px 0 4px"><a href="${esc(link)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">See the quotation</a></p>
<p style="margin:16px 0 0;color:#71717a;font-size:13px;line-height:1.5">${esc(store.name)} Bangladesh${store.phone ? ` · ${esc(store.phone)}` : ''}${store.email ? ` · ${esc(store.email)}` : ''}</p>
</div></body></html>`;
  const text = [
    `Your quotation ${no}`,
    '',
    `Dear ${q.name},`,
    `Here is the quotation${q.organisation ? ` for ${q.organisation}` : ''} you asked for: ${taka(q.subtotal)} for the items. ${delivery}`,
    `The prices are valid until ${day(q.validUntil)}.`,
    ...(q.terms ? ['', q.terms] : []),
    '',
    `See it and order: ${link}`,
    '',
    store.name,
  ].join('\n');
  return { subject, html, text };
}

/** SMS and emails a quotation was sent with (newest first). */
export const quotationMessages = (number: number) =>
  db
    .select({ id: messageLog.id, channel: messageLog.channel, to: messageLog.to, status: messageLog.status, error: messageLog.error, createdAt: messageLog.createdAt })
    .from(messageLog)
    .where(like(messageLog.purpose, `quote.sent ${quoteNumber(number)}`))
    .orderBy(desc(messageLog.createdAt), desc(messageLog.id));

