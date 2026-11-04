import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { customerAddresses, customers } from '../../../db/schema/index.ts';
import type { Tx } from '../products/service.ts';
import type { CheckoutSettings } from '../settings/schemas.ts';
import { AREAS, DISTRICTS } from '../settings/service.ts';

type Customer = typeof customers.$inferSelect;
type Address = typeof customerAddresses.$inferSelect;

/** An approved business can buy at wholesale prices. */
export const isApprovedBusiness = (c: Pick<Customer, 'type' | 'businessStatus'> | null | undefined) =>
  c?.type === 'business' && c.businessStatus === 'approved';

/** The shop's wholesale terms, with the business's own terms on top (empty fields keep the shop's). */
export function wholesaleTermsFor(customer: Pick<Customer, 'type' | 'businessStatus' | 'wholesaleTerms'> | null | undefined, shop: CheckoutSettings['wholesale']) {
  const own = isApprovedBusiness(customer) ? customer!.wholesaleTerms : null;
  if (!own) return shop;
  return {
    ...shop,
    advancePercent: own.advancePercent ?? shop.advancePercent,
    minOrderAmount: own.minOrderAmount ?? shop.minOrderAmount,
    delivery: own.delivery ?? shop.delivery,
    deliveryFee: own.delivery ? own.deliveryFee : shop.deliveryFee,
  };
}

export const addressView = (a: Address) => ({
  id: a.id,
  label: a.label,
  recipientName: a.recipientName,
  recipientPhone: a.recipientPhone,
  districtId: a.districtId,
  districtName: DISTRICTS.get(a.districtId)?.name ?? a.districtId,
  areaId: a.areaId,
  areaName: a.areaId ? (AREAS.get(a.areaId)?.name ?? null) : null,
  address: a.address,
  isDefault: a.isDefault,
});

const sameText = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** Saves an address used on an order, unless the customer already has it. The first one becomes the default. */
export async function rememberAddress(
  tx: Tx | typeof db,
  customerId: number,
  place: { districtId: string; areaId: string | null; address: string },
) {
  const saved = await tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId));
  const known = saved.some(
    (a) => a.districtId === place.districtId && (a.areaId ?? null) === (place.areaId ?? null) && sameText(a.address, place.address),
  );
  if (known) return;
  await tx.insert(customerAddresses).values({ customerId, ...place, isDefault: saved.length === 0 });
}

/** Makes one address the default (and no other). */
export async function setDefaultAddress(tx: Tx, customerId: number, addressId: number) {
  await tx
    .update(customerAddresses)
    .set({ isDefault: false })
    .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefault, true)));
  await tx.update(customerAddresses).set({ isDefault: true }).where(eq(customerAddresses.id, addressId));
}
