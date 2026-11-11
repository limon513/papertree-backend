import { z } from 'zod';

/**
 * Bulk discounts: buy more of a product, pay less per piece ("10 or more: 5% off"). Retail only
 * (wholesale has its own prices). The pieces of all options of one product count together (6 red +
 * 6 blue pens = 12). Shown in the cart and at checkout, not on product pages (the shop's choice).
 */

export interface BulkTier {
  /** From this many pieces of the product. */
  minQuantity: number;
  /** Percent off each piece. */
  percent: number;
}

/** A product's own rule. null: the shop's tiers. */
export type ProductBulk = { mode: 'off' } | { mode: 'own'; tiers: BulkTier[] } | null;

export interface BulkRules {
  /** Off: no bulk discounts anywhere (product rules included). */
  enabled: boolean;
  tiers: BulkTier[];
  /** Also on items already on sale. */
  onSale: boolean;
}

export const MAX_TIERS = 5;

export const bulkTiersSchema = z
  .array(
    z.object({
      minQuantity: z
        .number({ error: 'Enter how many pieces' })
        .int({ error: 'Whole pieces only' })
        .min(2, { error: 'At least 2 pieces' })
        .max(100_000, { error: 'Too many' }),
      percent: z
        .number({ error: 'Enter the discount' })
        .min(0.5, { error: 'At least 0.5%' })
        .max(90, { error: 'At most 90%' })
        .transform((v) => Math.round(v * 100) / 100),
    }),
  )
  .max(MAX_TIERS, { error: `At most ${MAX_TIERS} steps` })
  .transform((tiers) => [...tiers].sort((a, b) => a.minQuantity - b.minQuantity))
  .superRefine((tiers, ctx) => {
    tiers.forEach((t, i) => {
      const before = tiers[i - 1];
      if (!before) return;
      if (t.minQuantity === before.minQuantity) ctx.addIssue({ code: 'custom', path: [i, 'minQuantity'], message: 'Two steps with the same number of pieces' });
      else if (t.percent <= before.percent) ctx.addIssue({ code: 'custom', path: [i, 'percent'], message: 'Buying more must give a bigger discount' });
    });
  });

export const productBulkSchema = z
  .union([z.object({ mode: z.literal('off') }), z.object({ mode: z.literal('own'), tiers: bulkTiersSchema.refine((t) => t.length > 0, { error: 'Add at least one step' }) })])
  .nullable()
  .default(null)
  .meta({ description: "null: the shop's bulk discounts; off: none for this product; own: its own steps" });

export interface BulkLineIn {
  productId: number;
  quantity: number;
  /** Today's price per piece (the sale price while a sale runs). */
  price: number;
  onSale: boolean;
}

export interface BulkLineOut {
  percent: number;
  /** Taka off the whole line (whole taka, so cash-on-delivery totals stay round). */
  discount: number;
  /** What the line costs after the discount. */
  lineTotal: number;
  /** Per piece after the discount (for invoices). */
  unitPrice: number;
  /** The next step for this product: "add 3 more for 10% off". null when none. */
  next: { more: number; percent: number } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The tiers that apply to a product, or none. */
function tiersFor(rules: BulkRules, product: ProductBulk | undefined): BulkTier[] {
  if (!rules.enabled) return [];
  if (product?.mode === 'off') return [];
  const raw: unknown = product?.mode === 'own' ? product.tiers : rules.tiers;
  // Read defensively: only sensible steps count, smallest first, never more than 90% off.
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is BulkTier => !!t && Number.isInteger(t.minQuantity) && t.minQuantity >= 2 && typeof t.percent === 'number' && t.percent > 0)
    .map((t) => ({ minQuantity: t.minQuantity, percent: Math.min(90, t.percent) }))
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

/** Works out the bulk discount of each line (same order as given). */
export function applyBulk(lines: BulkLineIn[], rules: BulkRules, productRules: Map<number, ProductBulk>): BulkLineOut[] {
  const pieces = new Map<number, number>();
  for (const l of lines) pieces.set(l.productId, (pieces.get(l.productId) ?? 0) + l.quantity);

  return lines.map((l) => {
    const full = round2(l.price * l.quantity);
    const tiers = tiersFor(rules, productRules.get(l.productId));
    const count = pieces.get(l.productId) ?? 0;
    const reached = [...tiers].reverse().find((t) => count >= t.minQuantity);
    const after = tiers.find((t) => count < t.minQuantity);
    const next = after ? { more: after.minQuantity - count, percent: after.percent } : null;
    // Sale items: no extra discount unless the shop allows it (and then no nudge either).
    if (!reached || (l.onSale && !rules.onSale)) {
      return { percent: 0, discount: 0, lineTotal: full, unitPrice: l.price, next: l.onSale && !rules.onSale ? null : next };
    }
    const discount = Math.min(full, Math.round((full * reached.percent) / 100));
    // Too small to round to a taka: no discount (and no "5% applied" label with nothing off).
    if (discount <= 0) return { percent: 0, discount: 0, lineTotal: full, unitPrice: l.price, next };
    const lineTotal = round2(full - discount);
    return { percent: reached.percent, discount, lineTotal, unitPrice: round2(lineTotal / l.quantity), next };
  });
}
