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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const site = () => env.STOREFRONT_URL.replace(/\/$/, '');
const admin = () => env.ADMIN_APP_URL.replace(/\/$/, '');

async function load(orderId: number) {
  const [row] = await db
    .select({ order: orders, deliveryTime: deliveryZones.deliveryTime })
    .from(orders)
    .leftJoin(deliveryZones, eq(deliveryZones.id, orders.deliveryZoneId))
    .where(eq(orders.id, orderId));
  if (!row) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.position));
  const [store, images] = await Promise.all([getSettings('store'), imagesById(items.map((i) => i.imageId))]);
  const logo = store.logoImageId ? (await imagesById([store.logoImageId])).get(store.logoImageId) : undefined;
  return { order: row.order, deliveryTime: row.deliveryTime, items, store, images, logoUrl: logo ? (logo.urls['160'] ?? Object.values(logo.urls)[0]) : null };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

/** Was this email already sent (a retried job)? */
async function alreadySent(purpose: string) {
  const [row] = await db
    .select({ id: messageLog.id })
    .from(messageLog)
    .where(and(eq(messageLog.purpose, purpose), inArray(messageLog.status, ['sent'])))
    .limit(1);
  return !!row;
}

// ---- The email layout (inline styles: email apps ignore stylesheets) ----

function layout(d: Loaded, title: string, body: string) {
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

function itemsTable(d: Loaded) {
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
${line('Items', taka(o.subtotal))}${o.bulkDiscount ? line('You saved with bulk discounts', taka(o.bulkDiscount)) : ''}${o.discount ? line('Discount', `−${taka(o.discount)}`) : ''}${line('Delivery', o.deliveryFee === 0 ? 'Free' : taka(o.deliveryFee))}${line('Total (cash on delivery)', taka(o.total), true)}
</table>`;
}

const placeOf = (o: Loaded['order']) => [o.address, o.areaName, o.districtName].filter(Boolean).join(', ');
const button = (href: string, label: string) =>
  `<p style="margin:20px 0 4px"><a href="${esc(href)}" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${esc(label)}</a></p>`;

// ---- The two emails ----

function customerEmail(d: Loaded) {
  const o = d.order;
  const first = o.customerName.split(' ')[0] ?? o.customerName;
  const link = o.publicToken ? `${site()}/checkout/thank-you/?o=${encodeURIComponent(o.publicToken)}` : `${site()}/`;
  const place = placeOf(o);
  const html = layout(
    d,
    `Thank you, ${first}! Your order #${o.number} is placed.`,
    `<p style="margin:0 0 8px;font-size:15px;line-height:1.55">We will call you on <strong>${esc(o.phone)}</strong> soon to confirm it. Then we send it to <strong>${esc(place)}</strong>${d.deliveryTime ? `, usually in <strong>${esc(d.deliveryTime)}</strong>` : ''}. Pay <strong>${taka(o.total)}</strong> in cash when it arrives.</p>
${itemsTable(d)}
${o.customerNote ? `<p style="font-size:14px;color:#52525b">Your note: ${esc(o.customerNote)}</p>` : ''}
${button(link, 'See your order')}
<p style="font-size:13px;color:#71717a;margin-top:16px">Questions? Reply to this email${d.store.phone ? ` or call ${esc(d.store.phone)}` : ''}.</p>`,
  );
  const text = [
    `Thank you, ${first}! Your order #${o.number} is placed.`,
    `We will call you on ${o.phone} soon to confirm it. Then we send it to ${place}${d.deliveryTime ? `, usually in ${d.deliveryTime}` : ''}.`,
    '',
    ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}: ${taka(i.lineTotal)}${i.bulkPercent ? ` (${i.bulkPercent}% bulk discount)` : ''}`),
    '',
    `Items: ${taka(o.subtotal)}`,
    ...(o.bulkDiscount ? [`You saved ${taka(o.bulkDiscount)} with bulk discounts`] : []),
    `Delivery: ${o.deliveryFee === 0 ? 'Free' : taka(o.deliveryFee)}`,
    `Total (cash on delivery): ${taka(o.total)}`,
    '',
    `See your order: ${link}`,
  ].join('\n');
  return { subject: `Order #${o.number} placed: ${taka(o.total)}`, html, text };
}

function shopEmail(d: Loaded) {
  const o = d.order;
  const link = `${admin()}/orders/${o.id}`;
  const html = layout(
    d,
    `New website order #${o.number}: ${taka(o.total)}`,
    `<p style="margin:0 0 4px;font-size:15px"><strong>${esc(o.customerName)}</strong> · <a href="tel:${esc(o.phone)}" style="color:#1d5b2c">${esc(o.phone)}</a>${o.email ? ` · ${esc(o.email)}` : ''}</p>
<p style="margin:0;font-size:14px;color:#52525b">${esc(placeOf(o))}${o.deliveryZoneName ? ` (${esc(o.deliveryZoneName)})` : ''}</p>
${o.customerNote ? `<p style="font-size:14px;background:#fffbeb;padding:8px 12px;border-radius:8px">Note: ${esc(o.customerNote)}</p>` : ''}
${itemsTable(d)}
${button(link, 'Open the order')}`,
  );
  const text = [
    `New website order #${o.number}: ${taka(o.total)}`,
    `${o.customerName}, ${o.phone}${o.email ? `, ${o.email}` : ''}`,
    placeOf(o),
    ...(o.customerNote ? [`Note: ${o.customerNote}`] : []),
    '',
    ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}: ${taka(i.lineTotal)}`),
    '',
    `Open the order: ${link}`,
  ].join('\n');
  return { subject: `New order #${o.number} · ${taka(o.total)} · ${o.customerName}`, html, text };
}

/** Sends the order's emails (the background job calls this). */
export async function sendOrderEmails(orderId: number) {
  const d = await load(orderId);
  if (!d) return;
  const { settings } = await getIntegration('email');
  const o = d.order;

  if (o.email) {
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
