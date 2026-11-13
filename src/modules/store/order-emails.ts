import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { deliveryZones, messageLog, orderItems, orders } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { getIntegration, sendEmail } from '../admin/integrations/service.ts';
import { getSettings } from '../admin/settings/service.ts';
import { imagesById } from './catalog.ts';

/**
 * Emails after a website order: a confirmation to the customer (when they gave an email) and an
 * alert to the shop (Integrations → Email → "New-order alerts to"). Run by a background job, so
 * checkout never waits for email. Each is sent once: a retry skips what was already sent.
 */

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const site = () => env.STOREFRONT_URL.replace(/\/$/, '');
const admin = () => env.ADMIN_APP_URL.replace(/\/$/, '');

export async function load(orderId: number) {
  const [row] = await db
    .select({ order: orders, deliveryTime: deliveryZones.deliveryTime })
    .from(orders)
    .leftJoin(deliveryZones, eq(deliveryZones.id, orders.deliveryZoneId))
    .where(eq(orders.id, orderId));
  if (!row) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.position));
  const [store, images, checkout] = await Promise.all([getSettings('store'), imagesById(items.map((i) => i.imageId)), getSettings('checkout')]);
  const logo = store.logoImageId ? (await imagesById([store.logoImageId])).get(store.logoImageId) : undefined;
  return { order: row.order, deliveryTime: row.deliveryTime, items, store, images, payAdvance: checkout.wholesale.payAdvance, logoUrl: logo ? (logo.urls['160'] ?? Object.values(logo.urls)[0]) : null };
}
export type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

/** Was this message already sent (a retried job, or the same step twice)? */
export async function alreadySent(purpose: string, channel: 'email' | 'sms' = 'email') {
  const [row] = await db
    .select({ id: messageLog.id })
    .from(messageLog)
    .where(and(eq(messageLog.purpose, purpose), eq(messageLog.channel, channel), inArray(messageLog.status, ['sent'])))
    .limit(1);
  return !!row;
}

// ---- The email layout (inline styles: email apps ignore stylesheets) ----

export function layout(d: Loaded, title: string, body: string) {
  const { store } = d;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Segoe UI,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#1d5b2c;padding:18px 24px">
${d.logoUrl ? `<img src="${esc(d.logoUrl)}" alt="" height="36" style="vertical-align:middle;border-radius:8px;background:#fff;margin-right:10px">` : ''}
<span style="color:#fff;font-size:20px;font-weight:700;vertical-align:middle">${esc(store.name)}</span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">${esc(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 24px;background:#fafafa;color:#71717a;font-size:13px;line-height:1.5">
${esc(store.name)} Bangladesh${store.phone ? ` · ${esc(store.phone)}` : ''}${store.email ? ` · ${esc(store.email)}` : ''}${store.address ? `<br>${esc(store.address)}` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

export function itemsTable(d: Loaded, totalLabel = 'Total (cash on delivery)') {
  const rows = d.items
    .map((i) => {
      const img = i.imageId ? d.images.get(i.imageId) : undefined;
      const src = img ? (img.urls['160'] ?? Object.values(img.urls)[0]) : null;
      return `<tr>
<td style="padding:8px 0;width:56px;vertical-align:top">${src ? `<img src="${esc(src)}" alt="" width="48" height="48" style="border-radius:8px;background:#f4f4f5;object-fit:contain">` : ''}</td>
<td style="padding:8px 8px;vertical-align:top;font-size:14px">${esc(i.name)}${i.variantLabel ? `<br><span style="color:#71717a;font-size:13px">${esc(i.variantLabel)}</span>` : ''}<br><span style="color:#71717a;font-size:13px">${i.quantity} × ${taka(i.unitPrice)}${i.bulkPercent ? ` · <span style="color:#1d5b2c">${i.bulkPercent}% bulk discount</span>` : ''}</span></td>
<td style="padding:8px 0;vertical-align:top;text-align:right;font-size:14px;white-space:nowrap">${taka(i.lineTotal)}</td></tr>`;
    })
    .join('');
  const o = d.order;
  const line = (label: string, value: string, strong = false) =>
    `<tr><td colspan="2" style="padding:4px 0;font-size:${strong ? 16 : 14}px;${strong ? 'font-weight:700' : 'color:#52525b'}">${label}</td><td style="padding:4px 0;text-align:right;font-size:${strong ? 16 : 14}px;${strong ? 'font-weight:700' : ''}">${value}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;margin:16px 0">${rows}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${line('Items', taka(o.subtotal))}${o.bulkDiscount ? line('You saved with bulk discounts', taka(o.bulkDiscount)) : ''}${o.discount ? line('Discount', `−${taka(o.discount)}`) : ''}${o.couponDiscount ? line(`Coupon ${esc(o.couponCode ?? '')}`, `−${taka(o.couponDiscount)}`) : ''}${line('Delivery', o.deliveryFee === 0 ? 'Free' : taka(o.deliveryFee))}${line(totalLabel, taka(o.total), true)}
</table>`;
}

export const placeOf = (o: Loaded['order']) => [o.address, o.areaName, o.districtName].filter(Boolean).join(', ');
export const button = (href: string, label: string) =>
  `<p style="margin:20px 0 4px"><a href="${esc(href)}" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${esc(label)}</a></p>`;

// ---- The two emails ----

/**
 * A wholesale order with an advance still to pay: what to pay, how, and what is left for delivery.
 * null for retail orders and paid advances.
 */
function advanceOf(d: Loaded) {
  const o = d.order;
  if (o.type !== 'wholesale') return null;
  const toPay = Math.max(0, Math.round((o.advanceRequired - o.paidAmount) * 100) / 100);
  if (toPay <= 0) return null;
  return { toPay, rest: Math.round((o.total - o.advanceRequired) * 100) / 100, how: d.payAdvance };
}

function customerEmail(d: Loaded) {
  const o = d.order;
  const first = o.customerName.split(' ')[0] ?? o.customerName;
  const link = o.publicToken ? `${site()}/checkout/thank-you/?o=${encodeURIComponent(o.publicToken)}` : `${site()}/`;
  const place = placeOf(o);
  const wholesale = o.type === 'wholesale';
  const adv = advanceOf(d);
  const kind = wholesale ? 'wholesale order' : 'order';
  const when = d.deliveryTime ? `, usually in ${d.deliveryTime}` : '';
  const whenHtml = d.deliveryTime ? `, usually in <strong>${esc(d.deliveryTime)}</strong>` : '';
  const para = (html: string) => `<p style="margin:0 0 8px;font-size:15px;line-height:1.55">${html}</p>`;
  // What happens next, and how they pay.
  const next = adv
    ? {
        html:
          para(`To start, please pay the advance of <strong>${taka(adv.toPay)}</strong>${adv.how ? `: ${esc(adv.how)}` : ''}. Write your order number <strong>#${o.number}</strong> as the reference.`) +
          para(`We will call you on <strong>${esc(o.phone)}</strong> to confirm. Once the advance arrives we send it to <strong>${esc(place)}</strong>${whenHtml}. The rest, <strong>${taka(adv.rest)}</strong>, is paid on delivery.`),
        text: [
          `To start, please pay the advance of ${taka(adv.toPay)}${adv.how ? `: ${adv.how}` : ''}. Write your order number #${o.number} as the reference.`,
          `We will call you on ${o.phone} to confirm. Once the advance arrives we send it to ${place}${when}. The rest, ${taka(adv.rest)}, is paid on delivery.`,
        ],
      }
    : {
        html: para(`We will call you on <strong>${esc(o.phone)}</strong> soon to confirm it. Then we send it to <strong>${esc(place)}</strong>${whenHtml}. Pay <strong>${taka(o.total)}</strong> in cash when it arrives.`),
        text: [`We will call you on ${o.phone} soon to confirm it. Then we send it to ${place}${when}.`],
      };
  const totalLabel = wholesale ? 'Total' : 'Total (cash on delivery)';
  const html = layout(
    d,
    `Thank you, ${first}! Your ${kind} #${o.number} is placed.`,
    `${next.html}
${itemsTable(d, totalLabel)}
${adv ? `<p style="font-size:14px;margin:4px 0 0">Advance to pay now: <strong>${taka(adv.toPay)}</strong> · On delivery: <strong>${taka(adv.rest)}</strong></p>` : ''}
${o.customerNote ? `<p style="font-size:14px;color:#52525b">Your note: ${esc(o.customerNote)}</p>` : ''}
${button(link, 'See your order')}
<p style="font-size:13px;color:#71717a;margin-top:16px">Questions? Reply to this email${d.store.phone ? ` or call ${esc(d.store.phone)}` : ''}.</p>`,
  );
  const text = [
    `Thank you, ${first}! Your ${kind} #${o.number} is placed.`,
    ...next.text,
    '',
    ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}: ${taka(i.lineTotal)}${i.bulkPercent ? ` (${i.bulkPercent}% bulk discount)` : ''}`),
    '',
    `Items: ${taka(o.subtotal)}`,
    ...(o.bulkDiscount ? [`You saved ${taka(o.bulkDiscount)} with bulk discounts`] : []),
    `Delivery: ${o.deliveryFee === 0 ? 'Free' : taka(o.deliveryFee)}`,
    ...(o.couponDiscount ? [`Coupon ${o.couponCode}: −${taka(o.couponDiscount)}`] : []),
    `${totalLabel}: ${taka(o.total)}`,
    ...(adv ? [`Advance to pay now: ${taka(adv.toPay)} · On delivery: ${taka(adv.rest)}`] : []),
    '',
    `See your order: ${link}`,
  ].join('\n');
  return { subject: `${wholesale ? 'Wholesale order' : 'Order'} #${o.number} placed: ${taka(o.total)}`, html, text };
}

function shopEmail(d: Loaded) {
  const o = d.order;
  const link = `${admin()}/orders/${o.id}`;
  const wholesale = o.type === 'wholesale';
  const adv = advanceOf(d);
  const title = `New ${wholesale ? 'wholesale' : 'website'} order #${o.number}: ${taka(o.total)}`;
  const collect = adv ? `Wholesale: collect the advance of ${taka(adv.toPay)} before sending. The rest, ${taka(adv.rest)}, on delivery.` : null;
  const html = layout(
    d,
    title,
    `<p style="margin:0 0 4px;font-size:15px"><strong>${esc(o.customerName)}</strong> · <a href="tel:${esc(o.phone)}" style="color:#1d5b2c">${esc(o.phone)}</a>${o.email ? ` · ${esc(o.email)}` : ''}</p>
<p style="margin:0;font-size:14px;color:#52525b">${esc(placeOf(o))}${o.deliveryZoneName ? ` (${esc(o.deliveryZoneName)})` : ''}</p>
${collect ? `<p style="font-size:14px;background:#ecfdf5;padding:8px 12px;border-radius:8px">${esc(collect)}</p>` : ''}
${o.customerNote ? `<p style="font-size:14px;background:#fffbeb;padding:8px 12px;border-radius:8px">Note: ${esc(o.customerNote)}</p>` : ''}
${itemsTable(d, wholesale ? 'Total' : 'Total (cash on delivery)')}
${button(link, 'Open the order')}`,
  );
  const text = [
    title,
    `${o.customerName}, ${o.phone}${o.email ? `, ${o.email}` : ''}`,
    placeOf(o),
    ...(collect ? [collect] : []),
    ...(o.customerNote ? [`Note: ${o.customerNote}`] : []),
    '',
    ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}: ${taka(i.lineTotal)}`),
    '',
    `Open the order: ${link}`,
  ].join('\n');
  return { subject: `New ${wholesale ? 'WHOLESALE ' : ''}order #${o.number} · ${taka(o.total)} · ${o.customerName}`, html, text };
}

/** Sends the order's emails (the background job calls this). */
export async function sendOrderEmails(orderId: number) {
  const d = await load(orderId);
  if (!d) return;
  const [{ settings }, messages] = await Promise.all([getIntegration('email'), getSettings('messages')]);
  const o = d.order;

  if (o.email && messages.placed.email) {
    const purpose = `order.placed #${o.number}`;
    if (!(await alreadySent(purpose))) await sendEmail({ to: o.email, ...customerEmail(d), purpose });
  }
  if (settings.staffEmail) {
    const purpose = `order.alert #${o.number}`;
    if (!(await alreadySent(purpose))) await sendEmail({ to: settings.staffEmail, ...shopEmail(d), purpose });
  }
  logger.info({ order: o.number }, 'Order emails done');
}

/** For tests and the admin: the emails an order sent. */
export const orderEmailsOf = (number: number) => db.select().from(messageLog).where(like(messageLog.purpose, `order.% #${number}`));

/** The order's two emails without sending them (to check how they look). */
export async function previewOrderEmails(orderId: number) {
  const d = await load(orderId);
  return d ? { customer: customerEmail(d), shop: shopEmail(d) } : null;
}
