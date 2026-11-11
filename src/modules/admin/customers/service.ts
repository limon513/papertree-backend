import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { customerAddresses, customers } from '../../../db/schema/index.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import type { Tx } from '../products/service.ts';
import type { CheckoutSettings } from '../settings/schemas.ts';
import { AREAS, DISTRICTS } from '../settings/service.ts';
import type { AddressInput } from './schemas.ts';

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
  const known = saved.find(
    (a) => a.districtId === place.districtId && (a.areaId ?? null) === (place.areaId ?? null) && sameText(a.address, place.address),
  );
  // Used again: it becomes the latest (the website fills in the latest when there is no default).
  if (known) {
    await tx.update(customerAddresses).set({ updatedAt: new Date() }).where(eq(customerAddresses.id, known.id));
    return;
  }
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

// ---- Saved addresses (staff and the shopper's own account use the same rules) ----

/** The district must exist, and the area must be in it. */
export function checkPlace(input: Pick<AddressInput, 'districtId' | 'areaId'>) {
  if (!DISTRICTS.has(input.districtId)) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  if (input.areaId && AREAS.get(input.areaId)?.districtId !== input.districtId) {
    throw badRequest('Choose an area in this district', { areaId: 'Choose an area in this district' });
  }
}

export async function getAddress(customerId: number, addressId: number) {
  const [row] = await db
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)));
  if (!row) throw notFound('Address not found');
  return row;
}

/** A customer's addresses, the default first, then the latest used. */
export const addressesOf = (customerId: number) =>
  db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, customerId))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.updatedAt));

/** Adds an address. The first one becomes the default. `max`: how many one customer may keep. */
export async function addAddress(customerId: number, input: AddressInput, max = Infinity) {
  checkPlace(input);
  return db.transaction(async (tx) => {
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(customerAddresses).where(eq(customerAddresses.customerId, customerId));
    if (n >= max) throw badRequest(`You can keep up to ${max} addresses. Remove one you no longer use.`);
    const [row] = await tx
      .insert(customerAddresses)
      .values({ ...input, customerId, isDefault: false })
      .returning({ id: customerAddresses.id });
    if (input.isDefault || n === 0) await setDefaultAddress(tx, customerId, row!.id);
    return row!.id;
  });
}

export async function updateAddress(customerId: number, addressId: number, input: AddressInput) {
  const before = await getAddress(customerId, addressId);
  checkPlace(input);
  await db.transaction(async (tx) => {
    await tx
      .update(customerAddresses)
      .set({ ...input, isDefault: before.isDefault })
      .where(eq(customerAddresses.id, addressId));
    if (input.isDefault && !before.isDefault) await setDefaultAddress(tx, customerId, addressId);
  });
}

/** Removes an address. When it was the default, the latest used one becomes the default. */
export async function deleteAddress(customerId: number, addressId: number) {
  const address = await getAddress(customerId, addressId);
  await db.transaction(async (tx) => {
    await tx.delete(customerAddresses).where(eq(customerAddresses.id, address.id));
    if (address.isDefault) {
      const [next] = await tx
        .select({ id: customerAddresses.id })
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, customerId))
        .orderBy(desc(customerAddresses.updatedAt))
        .limit(1);
      if (next) await setDefaultAddress(tx, customerId, next.id);
    }
  });
}

export async function makeDefaultAddress(customerId: number, addressId: number) {
  await getAddress(customerId, addressId);
  await db.transaction((tx) => setDefaultAddress(tx, customerId, addressId));
}
