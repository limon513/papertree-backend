import { Router } from 'express';
import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { deliveryZones, inventoryLevels, inventoryMovements, stockLocations } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { checkImageId, withImage } from '../media/view.ts';
import { quoteBody, SETTINGS, stockLocationBody, zoneBody, type SettingsKey, type ZoneInput } from './schemas.ts';
import { AREAS, DISTRICTS, getSettings, listZones, LOCATIONS, quote, saveSettings } from './service.ts';

/** Mounted behind requireAdmin + requireModule('settings'). */
export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  const [store, checkout] = await Promise.all([getSettings('store'), getSettings('checkout')]);
  const { image: logo } = await withImage({ imageId: store.logoImageId });
  res.json({ store, checkout, logo });
});

for (const key of Object.keys(SETTINGS) as SettingsKey[]) {
  settingsRouter.put(`/${key}`, async (req, res) => {
    const value = SETTINGS[key].parse(req.body);
    if (key === 'store') await checkImageId((value as { logoImageId: number | null }).logoImageId);
    const before = await getSettings(key);
    await saveSettings(key, value, currentAdmin(req).id);
    await audit(req, { action: `settings.${key}`, entityType: 'settings', entityId: key, before, after: value });
    res.json(value);
  });
}

/** Divisions, districts and areas of Bangladesh. Never changes while the server runs. */
settingsRouter.get('/locations', (_req, res) => {
  res.set('cache-control', 'private, max-age=86400').json(LOCATIONS);
});

// ---- Delivery zones ----

const placeName = (id: string, kind: 'district' | 'area') =>
  kind === 'district' ? (DISTRICTS.get(id)?.name ?? id) : (AREAS.get(id)?.name ?? id);

/** Places must exist, and a place can be in only one active zone. */
async function checkZone(input: ZoneInput, exceptId?: number) {
  const unknown = [
    ...input.districtIds.filter((id) => !DISTRICTS.has(id)),
    ...input.areaIds.filter((id) => !AREAS.has(id)),
  ];
  if (unknown.length) throw badRequest('Some places are not in the list', { districtIds: `Unknown places: ${unknown.join(', ')}` });

  const others = (await listZones()).filter((z) => z.id !== exceptId);
  const sameName = others.find((z) => z.name.toLowerCase() === input.name.toLowerCase());
  if (sameName) throw conflict('A zone with this name already exists', { name: 'A zone with this name already exists' });

  if (!input.isActive) return;
  for (const other of others.filter((z) => z.isActive)) {
    const district = input.districtIds.find((id) => other.districtIds.includes(id));
    const area = input.areaIds.find((id) => other.areaIds.includes(id));
    if (district || area) {
      const name = district ? placeName(district, 'district') : placeName(area!, 'area');
      const message = `${name} is already in the zone "${other.name}". Remove it there first.`;
      throw conflict(message, { [district ? 'districtIds' : 'areaIds']: message });
    }
  }
}

async function getZone(id: number) {
  const [zone] = await db.select().from(deliveryZones).where(eq(deliveryZones.id, id));
  if (!zone) throw notFound('Delivery zone not found');
  return zone;
}

settingsRouter.get('/delivery-zones', async (_req, res) => {
  res.json({ items: await listZones() });
});

settingsRouter.post('/delivery-zones', async (req, res) => {
  const input = zoneBody.parse(req.body);
  await checkZone(input);
  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${deliveryZones.sortOrder}) + 1, 0)`.mapWith(Number) })
    .from(deliveryZones);
  const [zone] = await db
    .insert(deliveryZones)
    .values({ ...input, sortOrder: next })
    .returning();
  await audit(req, { action: 'delivery_zone.create', entityType: 'delivery_zone', entityId: zone!.id, after: input });
  res.status(201).json(zone);
});

settingsRouter.put('/delivery-zones/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getZone(id);
  const input = zoneBody.parse(req.body);
  if (before.isDefault && !input.isActive) {
    throw badRequest('The default zone cannot be turned off', { isActive: 'Orders to places in no other zone use this zone' });
  }
  await checkZone(input, id);
  const [zone] = await db.update(deliveryZones).set(input).where(eq(deliveryZones.id, id)).returning();
  await audit(req, { action: 'delivery_zone.update', entityType: 'delivery_zone', entityId: id, before, after: input });
  res.json(zone);
});

settingsRouter.delete('/delivery-zones/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const zone = await getZone(id);
  if (zone.isDefault) throw badRequest('The default zone cannot be deleted. It is used for every place not in another zone.');
  await db.delete(deliveryZones).where(eq(deliveryZones.id, id));
  await audit(req, { action: 'delivery_zone.delete', entityType: 'delivery_zone', entityId: id, before: zone });
  res.status(204).end();
});

/** Works out the delivery charge for a place, amount and weight, with the saved settings. */
settingsRouter.post('/delivery-quote', async (req, res) => {
  const input = quoteBody.parse(req.body);
  if (!DISTRICTS.has(input.districtId)) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  if (input.areaId && AREAS.get(input.areaId)?.districtId !== input.districtId) {
    throw badRequest('This area is not in that district', { areaId: 'Choose an area in this district' });
  }
  const [zones, checkout] = await Promise.all([listZones(), getSettings('checkout')]);
  res.json(quote(zones, checkout, input));
});

// ---- Stock locations ----

const unitsByLocation = () =>
  db
    .select({ locationId: inventoryLevels.locationId, units: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
    .from(inventoryLevels)
    .groupBy(inventoryLevels.locationId);

async function getLocation(id: number) {
  const [row] = await db.select().from(stockLocations).where(eq(stockLocations.id, id));
  if (!row) throw notFound('Stock location not found');
  return row;
}

async function checkLocationName(name: string, exceptId?: number) {
  const same = sql`lower(${stockLocations.name}) = ${name.toLowerCase()}`;
  const [row] = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(exceptId ? and(same, ne(stockLocations.id, exceptId)) : same);
  if (row) throw conflict('A location with this name already exists', { name: 'A location with this name already exists' });
}

settingsRouter.get('/stock-locations', async (_req, res) => {
  const [rows, units] = await Promise.all([
    db
      .select()
      .from(stockLocations)
      .orderBy(desc(stockLocations.isDefault), desc(stockLocations.isActive), asc(stockLocations.sortOrder), asc(stockLocations.name)),
    unitsByLocation(),
  ]);
  const byId = new Map(units.map((u) => [u.locationId, u.units]));
  res.json({
    items: rows.map((l) => ({
      id: l.id,
      name: l.name,
      isDefault: l.isDefault,
      isActive: l.isActive,
      sortOrder: l.sortOrder,
      units: byId.get(l.id) ?? 0,
    })),
  });
});

settingsRouter.post('/stock-locations', async (req, res) => {
  const input = stockLocationBody.parse(req.body);
  await checkLocationName(input.name);
  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${stockLocations.sortOrder}) + 1, 0)`.mapWith(Number) })
    .from(stockLocations);
  const [row] = await db
    .insert(stockLocations)
    .values({ ...input, sortOrder: next })
    .returning();
  await audit(req, { action: 'stock_location.create', entityType: 'stock_location', entityId: row!.id, after: input });
  res.status(201).json({ ...row, units: 0 });
});

settingsRouter.put('/stock-locations/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getLocation(id);
  const input = stockLocationBody.parse(req.body);
  if (before.isDefault && !input.isActive) {
    throw badRequest('The default location cannot be turned off', { isActive: 'Make another location the default first' });
  }
  await checkLocationName(input.name, id);
  const [row] = await db.update(stockLocations).set(input).where(eq(stockLocations.id, id)).returning();
  await audit(req, { action: 'stock_location.update', entityType: 'stock_location', entityId: id, before, after: input });
  res.json(row);
});

/** New products, imports and orders use the default location when none is chosen. */
settingsRouter.post('/stock-locations/:id/default', async (req, res) => {
  const id = parseId(req.params.id);
  const location = await getLocation(id);
  if (!location.isActive) throw badRequest('Turn this location on before making it the default');
  await db.transaction(async (tx) => {
    await tx.update(stockLocations).set({ isDefault: false }).where(eq(stockLocations.isDefault, true));
    await tx.update(stockLocations).set({ isDefault: true }).where(eq(stockLocations.id, id));
  });
  await audit(req, { action: 'stock_location.default', entityType: 'stock_location', entityId: id });
  res.status(204).end();
});

settingsRouter.delete('/stock-locations/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const location = await getLocation(id);
  if (location.isDefault) throw badRequest('The default location cannot be deleted');
  const [[units], [moves]] = await Promise.all([
    db
      .select({ n: sql<number>`coalesce(sum(abs(${inventoryLevels.quantity})), 0)`.mapWith(Number) })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.locationId, id)),
    db.select({ n: count() }).from(inventoryMovements).where(eq(inventoryMovements.locationId, id)),
  ]);
  if ((units?.n ?? 0) > 0) throw badRequest('This location still has stock. Move or remove the stock first, or turn it off.');
  if ((moves?.n ?? 0) > 0) throw badRequest('This location has stock history, so it cannot be deleted. Turn it off instead.');
  await db.transaction(async (tx) => {
    await tx.delete(inventoryLevels).where(eq(inventoryLevels.locationId, id));
    await tx.delete(stockLocations).where(eq(stockLocations.id, id));
  });
  await audit(req, { action: 'stock_location.delete', entityType: 'stock_location', entityId: id, before: location });
  res.status(204).end();
});
