import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { customers, wishlistItems } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { cardsByIds } from '../store/wishlist.ts';
import { pushSetup, type PushMessage } from './fcm.ts';
import { sendToCustomer } from './service.ts';

/**
 * "Your saved items" alerts, with care not to annoy:
 * - checked once a day, at 11 am Dhaka time (never at night);
 * - at most one alert a day per customer, all their news in it ("2 saved items: 1 back, 1 cheaper");
 * - only real news: back in stock after running out, or at least 5% cheaper than when saved or
 *   last told; the same change never twice (what was told is remembered on each saved item).
 */
export const MIN_DROP = 0.05;
const MIN_HOURS_BETWEEN = 20;

type Card = Awaited<ReturnType<typeof cardsByIds>>[number];
export interface News {
  card: Card;
  back: boolean;
  cheaper: boolean;
  was: number | null;
}

const tk = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** One short alert for everything new: one item gets its own words, several are summed up. */
export function alertFor(news: News[]): PushMessage {
  if (news.length === 1) {
    const { card, back, was } = news[0]!;
    const url = `/product/${card.slug}/`;
    const image = card.image ? (card.image.urls['400'] ?? Object.values(card.image.urls)[0] ?? null) : null;
    if (back) return { title: cut(`Back in stock: ${card.name}`, 65), body: 'One you saved. Order before it runs out again.', url, tag: 'wishlist', image };
    return { title: cut(`${card.name} is now ${tk(card.price)}`, 65), body: `${tk(Math.round((was! - card.price) * 100) / 100)} cheaper than before. One you saved: tap to see.`, url, tag: 'wishlist', image };
  }
  const back = news.filter((n) => n.back).length;
  const cheaper = news.length - back;
  const parts = [back && `${back} back in stock`, cheaper && `${cheaper} cheaper`].filter(Boolean).join(', ');
  const names = news.slice(0, 2).map((n) => cut(n.card.name, 30));
  const more = news.length > 2 ? ` and ${news.length - 2} more` : '';
  return { title: `${news.length} saved items: ${parts}`, body: `${names.join(', ')}${more}. Tap to see your wishlist.`, url: '/wishlist/', tag: 'wishlist' };
}

/** What is new on one saved item since the customer saw it (or was last told). */
export function newsOf(row: { priceWhenSaved: number | null; inStockWhenSaved: boolean; alertedPrice: number | null; alertedInStock: boolean | null }, card: Card): Omit<News, 'card'> | null {
  const basePrice = row.alertedPrice ?? row.priceWhenSaved;
  const baseStock = row.alertedInStock ?? row.inStockWhenSaved;
  const back = !baseStock && card.inStock;
  const cheaper = card.inStock && basePrice !== null && card.price <= basePrice * (1 - MIN_DROP) && basePrice - card.price >= 1;
  return back || cheaper ? { back, cheaper: !back && cheaper, was: basePrice } : null;
}

/** The daily check. Answers how many customers had news, and on how many devices it arrived. */
export async function runWishlistAlerts() {
  const setup = await pushSetup();
  if (!setup) return { customers: 0, sent: 0 };
  const { rows } = await db.execute<{ customer_id: string; product_id: string; price_when_saved: string | null; in_stock_when_saved: boolean; alerted_price: string | null; alerted_in_stock: boolean | null }>(sql`
    select w.customer_id, w.product_id, w.price_when_saved, w.in_stock_when_saved, w.alerted_price, w.alerted_in_stock
    from wishlist_items w
    join customers c on c.id = w.customer_id
    where c.push_wishlist
      and (c.last_wishlist_alert_at is null or c.last_wishlist_alert_at < now() - make_interval(hours => ${MIN_HOURS_BETWEEN}))
      and exists (select 1 from push_devices d where d.customer_id = c.id)`);
  if (!rows.length) return { customers: 0, sent: 0 };

  // Today's price and stock of every saved product (60 at a time).
  const ids = [...new Set(rows.map((r) => Number(r.product_id)))];
  const now = new Map<number, Card>();
  for (let i = 0; i < ids.length; i += 60) for (const c of await cardsByIds(ids.slice(i, i + 60))) now.set(c.id, c);

  const byCustomer = new Map<number, typeof rows>();
  for (const r of rows) byCustomer.set(Number(r.customer_id), [...(byCustomer.get(Number(r.customer_id)) ?? []), r]);

  let told = 0;
  let sent = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const [customerId, saved] of byCustomer) {
    const news: News[] = [];
    const ranOut: number[] = [];
    for (const r of saved) {
      const card = now.get(Number(r.product_id));
      if (!card) continue; // no longer for sale
      const row = { priceWhenSaved: r.price_when_saved === null ? null : Number(r.price_when_saved), inStockWhenSaved: r.in_stock_when_saved, alertedPrice: r.alerted_price === null ? null : Number(r.alerted_price), alertedInStock: r.alerted_in_stock };
      const n = newsOf(row, card);
      if (n) news.push({ card, ...n });
      // Sold out since: remembered quietly, so coming back later is news.
      else if ((row.alertedInStock ?? row.inStockWhenSaved) && !card.inStock) ranOut.push(card.id);
    }
    if (ranOut.length) await db.update(wishlistItems).set({ alertedInStock: false }).where(and(eq(wishlistItems.customerId, customerId), inArray(wishlistItems.productId, ranOut)));
    if (!news.length) continue;
    // Back in stock first, then the biggest drops.
    news.sort((a, b) => Number(b.back) - Number(a.back) || (b.was ?? 0) - b.card.price - ((a.was ?? 0) - a.card.price));
    sent += await sendToCustomer(customerId, 'wishlist', alertFor(news), `wishlist.alert #${customerId} ${today}`, { ttlSeconds: 86_400 });
    told++;
    // Told (or, in test mode, written to the log): remembered, so the same change never comes again.
    const at = new Date();
    for (const n of news) {
      await db.update(wishlistItems).set({ alertedPrice: n.card.price, alertedInStock: n.card.inStock, lastAlertAt: at }).where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.productId, n.card.id)));
    }
    await db.update(customers).set({ lastWishlistAlertAt: at }).where(eq(customers.id, customerId));
  }
  logger.info({ customers: told, sent }, 'Saved items alerts');
  return { customers: told, sent };
}
