import { Router } from 'express';
import { asc, eq, inArray, max } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { banners, media } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { mediaView } from '../media/view.ts';
import { bannerBody, bannerOrderBody, type BannerInput } from './schemas.ts';

/** Home page banners. Mounted behind requireAdmin + requireModule('content'). */
export const bannersRouter = Router();

type Row = typeof banners.$inferSelect;

/** Is it on the website right now? */
export function bannerState(b: Row, hasPicture: boolean, now = new Date()) {
  if (!hasPicture) return 'no_picture' as const;
  if (!b.isActive) return 'hidden' as const;
  if (b.startsAt && b.startsAt > now) return 'scheduled' as const;
  if (b.endsAt && b.endsAt <= now) return 'ended' as const;
  return 'live' as const;
}

async function views(rows: Row[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.imageId, r.mobileImageId]).filter((id): id is number => id !== null))];
  const found = ids.length ? await db.select().from(media).where(inArray(media.id, ids)) : [];
  const byId = new Map(found.map((m) => [m.id, mediaView(m)]));
  return rows.map((r) => {
    const image = r.imageId === null ? null : (byId.get(r.imageId) ?? null);
    return {
      id: r.id,
      placement: r.placement,
      title: r.title,
      image,
      mobileImage: r.mobileImageId === null ? null : (byId.get(r.mobileImageId) ?? null),
      linkUrl: r.linkUrl,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      state: bannerState(r, !!image),
    };
  });
}

const all = () => db.select().from(banners).orderBy(asc(banners.placement), asc(banners.sortOrder), asc(banners.id));

async function checkPictures(input: BannerInput) {
  const wanted = [input.imageId, input.mobileImageId].filter((id): id is number => id !== null);
  const found = await db.select({ id: media.id }).from(media).where(inArray(media.id, wanted));
  if (!found.some((m) => m.id === input.imageId)) throw badRequest('The picture was not found. Upload it again.', { imageId: 'Upload the picture again' });
  if (input.mobileImageId && !found.some((m) => m.id === input.mobileImageId)) {
    throw badRequest('The phone picture was not found. Upload it again.', { mobileImageId: 'Upload the picture again' });
  }
}

/** The next place at the end of a placement. */
async function lastIn(placement: BannerInput['placement']) {
  const [row] = await db.select({ last: max(banners.sortOrder) }).from(banners).where(eq(banners.placement, placement));
  return (row?.last ?? -1) + 1;
}

const values = (input: BannerInput) => ({
  ...input,
  startsAt: input.startsAt ? new Date(input.startsAt) : null,
  endsAt: input.endsAt ? new Date(input.endsAt) : null,
});

bannersRouter.get('/', async (_req, res) => {
  res.json(await views(await all()));
});

bannersRouter.post('/', async (req, res) => {
  const input = bannerBody.parse(req.body);
  await checkPictures(input);
  // New banners go last in their place.
  const [row] = await db.insert(banners).values({ ...values(input), sortOrder: await lastIn(input.placement) }).returning();
  await audit(req, { action: 'banner.create', entityType: 'banner', entityId: row!.id, after: input });
  res.status(201).json((await views([row!]))[0]);
});

bannersRouter.put('/order', async (req, res) => {
  const { ids } = bannerOrderBody.parse(req.body);
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(banners).set({ sortOrder: i }).where(eq(banners.id, id));
  });
  await audit(req, { action: 'banner.reorder', entityType: 'banner', after: { ids } });
  res.json(await views(await all()));
});

bannersRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = bannerBody.parse(req.body);
  const [before] = await db.select().from(banners).where(eq(banners.id, id));
  if (!before) throw notFound('Banner not found');
  await checkPictures(input);
  // Moved to the other place: last there.
  const sortOrder = input.placement === before.placement ? before.sortOrder : await lastIn(input.placement);
  const [row] = await db.update(banners).set({ ...values(input), sortOrder }).where(eq(banners.id, id)).returning();
  await audit(req, { action: 'banner.update', entityType: 'banner', entityId: id, before, after: input });
  res.json((await views([row!]))[0]);
});

bannersRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db.delete(banners).where(eq(banners.id, id)).returning();
  if (!row) throw notFound('Banner not found');
  await audit(req, { action: 'banner.delete', entityType: 'banner', entityId: id, before: row });
  res.status(204).end();
});
