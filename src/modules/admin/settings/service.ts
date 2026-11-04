import { readFileSync } from 'node:fs';
import { asc, desc, eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { deliveryZones, settings } from '../../../db/schema/index.ts';
import { SETTINGS, type CheckoutSettings, type SettingsKey } from './schemas.ts';

// ---- Bangladesh places (built by `npm run locations:build`) ----

export interface BdLocations {
  divisions: { id: string; name: string }[];
  districts: { id: string; name: string; divisionId: string }[];
  areas: { id: string; name: string; districtId: string; city: boolean }[];
}

const file = JSON.parse(readFileSync(new URL('../../../data/bd-locations.json', import.meta.url), 'utf8')) as BdLocations & {
  source: string;
};
export const LOCATIONS: BdLocations = { divisions: file.divisions, districts: file.districts, areas: file.areas };
export const DISTRICTS = new Map(LOCATIONS.districts.map((d) => [d.id, d]));
export const AREAS = new Map(LOCATIONS.areas.map((a) => [a.id, a]));

// ---- Settings sections ----

/** A settings section. Fields that were never saved get their defaults. */
export async function getSettings<K extends SettingsKey>(key: K) {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return SETTINGS[key].parse(row?.value ?? {}) as ReturnType<(typeof SETTINGS)[K]['parse']>;
}

export async function saveSettings(key: SettingsKey, value: unknown, adminUserId: number) {
  await db
    .insert(settings)
    .values({ key, value, updatedBy: adminUserId })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: adminUserId, updatedAt: new Date() } });
}

// ---- Delivery charge ----

export const listZones = () =>
  db.select().from(deliveryZones).orderBy(desc(deliveryZones.isActive), asc(deliveryZones.sortOrder), asc(deliveryZones.id));

type Zone = typeof deliveryZones.$inferSelect;

/** The zone for a place: the one listing the area, else the one listing the district, else the default. */
export function zoneFor(zones: Zone[], districtId: string, areaId: string | null) {
  const active = zones.filter((z) => z.isActive);
  return (
    (areaId ? active.find((z) => z.areaIds.includes(areaId)) : undefined) ??
    active.find((z) => z.districtIds.includes(districtId)) ??
    active.find((z) => z.isDefault) ??
    null
  );
}

export interface QuoteInput {
  districtId: string;
  areaId: string | null;
  subtotal: number;
  weightKg: number;
  wholesale: boolean;
}

/** Delivery charge for an order. Used by the admin "check a charge" tool and, later, the checkout. */
export function quote(zones: Zone[], checkout: CheckoutSettings, input: QuoteInput) {
  const zone = zoneFor(zones, input.districtId, input.areaId);
  const zoneInfo = zone ? { id: zone.id, name: zone.name, deliveryTime: zone.deliveryTime } : null;
  if (!zone) return { zone: null, fee: null, baseFee: 0, weightFee: 0, free: false, note: 'No delivery zone covers this place' };

  const extraKg =
    zone.includedKg !== null && zone.extraPerKg !== null ? Math.max(0, Math.ceil(input.weightKg - zone.includedKg - 1e-9)) : 0;
  const baseFee = zone.fee;
  const weightFee = extraKg * (zone.extraPerKg ?? 0);
  const result = (fee: number, free: boolean, note: string | null) => ({ zone: zoneInfo, fee, baseFee, weightFee, free, note });

  if (input.wholesale) {
    const w = checkout.wholesale;
    if (w.delivery === 'free') return result(0, true, 'Free delivery for wholesale orders');
    if (w.delivery === 'paid_on_delivery') return result(0, true, 'The customer pays the courier on delivery');
    if (w.delivery === 'fixed') return result(w.deliveryFee ?? 0, false, 'Fixed wholesale delivery charge');
  }
  if (zone.freeAbove !== null && input.subtotal >= zone.freeAbove) {
    return result(0, true, `Free delivery for orders of ৳${zone.freeAbove} or more`);
  }
  return result(baseFee + weightFee, false, extraKg > 0 ? `${extraKg} kg over the included ${zone.includedKg} kg` : null);
}
