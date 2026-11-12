/**
 * Coupon maths: what a code takes off an order. Pure (no database), so the cart, website orders and
 * staff orders share exactly the same sums. Whether a code may be used at all (dates, limits, who)
 * is checked separately, in the coupons service.
 *
 * Rules: one coupon per order; retail only; it works on the item prices after bulk discounts; it can
 * never take off more than the items it applies to (or more than the delivery charge, for free
 * delivery); amounts are whole taka.
 */

export const COUPON_TYPES = ['percent', 'fixed', 'free_delivery'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

/** Which items a coupon is for. All lists empty: every item. Otherwise an item in any list. */
export interface CouponItems {
  productIds: number[];
  /** Includes their sub-categories (expanded before the maths). */
  categoryIds: number[];
  brandIds: number[];
}

export interface CouponRule extends CouponItems {
  type: CouponType;
  /** percent: 0.5–90; fixed: taka; free_delivery: null. */
  value: number | null;
  /** percent: at most this many taka off. null: no cap. */
  maxDiscount: number | null;
  /** On the items the coupon is for, after bulk discounts. null: none. */
  minOrder: number | null;
  /** Also on items already on sale. */
  onSaleItems: boolean;
  /** Also on lines that got a bulk discount. */
  withBulk: boolean;
}

export interface CouponLine {
  productId: number;
  brandId: number | null;
  categoryIds: number[];
  /** What the line costs (after any bulk discount). */
  lineTotal: number;
  onSale: boolean;
  bulkPercent: number | null;
}

export interface CouponResult {
  ok: boolean;
  /** Why it gives nothing: no matching items, or the minimum is not reached. */
  reason: 'no_items' | 'min_order' | null;
  /** The items it applies to, in taka. */
  eligibleTotal: number;
  /** Taka more (on those items) to reach the minimum. */
  short: number | null;
  itemsOff: number;
  /** Free delivery: the delivery charge it takes off (0 while the charge is not known). */
  deliveryOff: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_PERCENT = 90;

function matches(rule: CouponItems, l: CouponLine) {
  const any = rule.productIds.length || rule.categoryIds.length || rule.brandIds.length;
  if (!any) return true;
  return rule.productIds.includes(l.productId) || (l.brandId !== null && rule.brandIds.includes(l.brandId)) || l.categoryIds.some((c) => rule.categoryIds.includes(c));
}

/** The lines this coupon applies to. */
export function couponLines(rule: CouponRule, lines: CouponLine[]) {
  return lines.filter((l) => matches(rule, l) && (rule.onSaleItems || !l.onSale) && (rule.withBulk || !l.bulkPercent));
}

/** What the coupon takes off. `deliveryFee`: the charge before the coupon (null: not known yet). */
export function couponAmount(rule: CouponRule, lines: CouponLine[], deliveryFee: number | null): CouponResult {
  const eligible = couponLines(rule, lines);
  const eligibleTotal = round2(eligible.reduce((s, l) => s + Math.max(0, l.lineTotal), 0));
  const none = (reason: CouponResult['reason'], short: number | null = null): CouponResult => ({ ok: false, reason, eligibleTotal, short, itemsOff: 0, deliveryOff: 0 });

  if (!eligible.length || eligibleTotal <= 0) return none('no_items');
  if (rule.minOrder !== null && eligibleTotal < rule.minOrder) return none('min_order', round2(rule.minOrder - eligibleTotal));

  // Never more than the items it applies to, in whole taka.
  const ceiling = Math.floor(eligibleTotal);
  let itemsOff = 0;
  let deliveryOff = 0;
  if (rule.type === 'percent') {
    const percent = Math.min(MAX_PERCENT, Math.max(0, rule.value ?? 0));
    itemsOff = Math.round((eligibleTotal * percent) / 100);
    if (rule.maxDiscount !== null) itemsOff = Math.min(itemsOff, Math.floor(Math.max(0, rule.maxDiscount)));
    itemsOff = Math.min(itemsOff, ceiling);
  } else if (rule.type === 'fixed') {
    itemsOff = Math.min(Math.floor(Math.max(0, rule.value ?? 0)), ceiling);
  } else {
    deliveryOff = Math.max(0, deliveryFee ?? 0);
  }
  // Too small to round to a taka: it gives nothing on these items.
  if (rule.type !== 'free_delivery' && itemsOff <= 0) return none('no_items');
  return { ok: true, reason: null, eligibleTotal, short: null, itemsOff, deliveryOff };
}
