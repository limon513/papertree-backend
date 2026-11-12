import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { categories } from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { checkImageId, withImage, withImages } from '../media/view.ts';
import { createCategoryBody, MAX_CATEGORY_DEPTH, reorderCategoriesBody, updateCategoryBody } from './schemas.ts';
import { addressChanged, addressesInUse } from '../seo/service.ts';

/** Mounted behind requireAdmin + requireModule('products'). */
export const categoriesRouter = Router();

type Category = typeof categories.$inferSelect;

/** Categories are few (hundreds at most), so tree checks load them all. */
const loadAll = () => db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name));

function find(rows: Category[], id: number) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFound('Category not found');
  return row;
}

/** 1 for a top-level category, 2 for its children, ... */
function depth(rows: Category[], id: number) {
  let level = 0;
  let current = rows.find((r) => r.id === id);
  while (current) {
    level++;
    current = current.parentId === null ? undefined : rows.find((r) => r.id === current!.parentId);
  }
  return level;
}

/** Levels in this category's branch: 1 if it has no sub-categories. */
function height(rows: Category[], id: number): number {
  const children = rows.filter((r) => r.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => height(rows, c.id)));
}

/** True if `id` is `ancestorId` itself or somewhere below it. */
function isInside(rows: Category[], id: number, ancestorId: number) {
  let current = rows.find((r) => r.id === id);
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parentId === null ? undefined : rows.find((r) => r.id === current!.parentId);
  }
  return false;
}

/** Checks that `movingId` (or a new category) can be placed under `parentId`. */
function checkParent(rows: Category[], parentId: number | null, movingId?: number) {
  if (parentId === null) return;
  const invalid = (message: string) => badRequest(message, { parentId: message });

  if (!rows.some((r) => r.id === parentId)) throw invalid('Choose a valid parent category');
  if (movingId !== undefined && isInside(rows, parentId, movingId)) {
    throw invalid('A category cannot go inside itself or its own sub-category');
  }
  const levels = depth(rows, parentId) + (movingId === undefined ? 1 : height(rows, movingId));
  if (levels > MAX_CATEGORY_DEPTH) throw invalid(`Categories can only be ${MAX_CATEGORY_DEPTH} levels deep`);
}

function checkName(rows: Category[], name: string, parentId: number | null, exceptId?: number) {
  const lower = name.toLowerCase();
  const clash = rows.some((r) => r.parentId === parentId && r.id !== exceptId && r.name.toLowerCase() === lower);
  if (clash) {
    const message = 'There is already a category with this name in the same place';
    throw conflict(message, { name: message });
  }
}

/** Uses the given slug (must be free) or makes a free one from the name. */
function pickSlug(rows: Category[], given: string | undefined, name: string, exceptId?: number) {
  const others = rows.filter((r) => r.id !== exceptId);
  if (given) {
    const owner = others.find((r) => r.slug === given);
    if (owner) {
      const message = `This URL name is already used by "${owner.name}"`;
      throw conflict(message, { slug: message });
    }
    return given;
  }
  const base = slugify(name);
  if (!base) throw badRequest('Enter a URL name', { slug: 'Enter a URL name using letters or numbers' });
  return freeSlug(base, new Set(others.map((r) => r.slug)));
}

/** Puts a category at the end of its new siblings. */
const nextSortOrder = (rows: Category[], parentId: number | null) =>
  1 + Math.max(-1, ...rows.filter((r) => r.parentId === parentId).map((r) => r.sortOrder));

categoriesRouter.get('/', async (_req, res) => {
  res.json({ items: await withImages(await loadAll()) });
});

categoriesRouter.get('/:id', async (req, res) => {
  const [row] = await db.select().from(categories).where(eq(categories.id, parseId(req.params.id))).limit(1);
  if (!row) throw notFound('Category not found');
  res.json(await withImage(row));
});

categoriesRouter.post('/', async (req, res) => {
  const input = createCategoryBody.parse(req.body);
  const rows = await loadAll();

  checkParent(rows, input.parentId);
  checkName(rows, input.name, input.parentId);
  await checkImageId(input.imageId);

  const [created] = await db
    .insert(categories)
    .values({
      name: input.name,
      slug: pickSlug(rows, input.slug, input.name),
      parentId: input.parentId,
      description: input.description ?? null,
      imageId: input.imageId ?? null,
      icon: input.icon ?? null,
      isActive: input.isActive,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
      sortOrder: nextSortOrder(rows, input.parentId),
    })
    .returning();
  // A real page lives at this address now: an old redirect from it would hide it.
  if (created) await addressesInUse(db, [`/product-category/${[...chainOf(rows, created.parentId), created.slug].join('/')}/`, `/product-category/${created.slug}/`]);

  await audit(req, { action: 'category.create', entityType: 'category', entityId: created!.id, after: created });
  res.status(201).json(await withImage(created!));
});

categoriesRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = updateCategoryBody.parse(req.body);
  const rows = await loadAll();
  const before = find(rows, id);

  const parentId = input.parentId === undefined ? before.parentId : input.parentId;
  const moved = parentId !== before.parentId;
  const name = input.name ?? before.name;

  if (moved) checkParent(rows, parentId, id);
  if (moved || input.name !== undefined) checkName(rows, name, parentId, id);
  await checkImageId(input.imageId);

  const [after] = await db
    .update(categories)
    .set({
      name: input.name,
      // An empty slug means "make a new one from the name".
      slug: input.slug === undefined ? undefined : pickSlug(rows, input.slug, name, id),
      parentId,
      sortOrder: moved ? nextSortOrder(rows, parentId) : undefined,
      description: input.description,
      imageId: input.imageId,
      icon: input.icon,
      isActive: input.isActive,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
    })
    .where(eq(categories.id, id))
    .returning();
  // A new address: the old ones (full and short) send people (and Google) to it. Sub-categories keep
  // working by themselves: the website finds a category by its own last part.
  if (after && after.slug !== before.slug) {
    const others = rows.filter((r) => r.id !== id);
    const pathOf = (slug: string, parent: number | null) => [...chainOf(others, parent), slug].join('/');
    const newPath = `/product-category/${pathOf(after.slug, after.parentId)}/`;
    await addressChanged(db, `/product-category/${pathOf(before.slug, before.parentId)}/`, newPath);
    await addressChanged(db, `/product-category/${before.slug}/`, newPath);
  }

  await audit(req, { action: 'category.update', entityType: 'category', entityId: id, before, after });
  res.json(await withImage(after!));
});

/** Slugs from the top category down to (and with) `parentId`. */
function chainOf(rows: { id: number; parentId: number | null; slug: string }[], parentId: number | null) {
  const chain: string[] = [];
  let at = parentId;
  for (let i = 0; at !== null && i < 20; i++) {
    const row = rows.find((r) => r.id === at);
    if (!row) break;
    chain.unshift(row.slug);
    at = row.parentId;
  }
  return chain;
}

categoriesRouter.post('/reorder', async (req, res) => {
  const input = reorderCategoriesBody.parse(req.body);
  const rows = await loadAll();
  const siblings = rows.filter((r) => r.parentId === input.parentId);

  const sameSet =
    input.ids.length === siblings.length &&
    new Set(input.ids).size === siblings.length &&
    siblings.every((s) => input.ids.includes(s.id));
  if (!sameSet) throw badRequest('The category list has changed. Reload the page and try again.');

  await db.transaction(async (tx) => {
    for (const [index, catId] of input.ids.entries()) {
      if (siblings.find((s) => s.id === catId)!.sortOrder !== index) {
        await tx.update(categories).set({ sortOrder: index }).where(eq(categories.id, catId));
      }
    }
  });

  await audit(req, {
    action: 'category.reorder',
    entityType: 'category',
    entityId: input.parentId ?? undefined,
    before: siblings.map((s) => s.id),
    after: input.ids,
  });
  res.status(204).end();
});

categoriesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const rows = await loadAll();
  const before = find(rows, id);

  const children = rows.filter((r) => r.parentId === id).length;
  if (children > 0) {
    throw badRequest(
      children === 1
        ? 'This category has a sub-category. Move or delete it first.'
        : `This category has ${children} sub-categories. Move or delete them first.`,
    );
  }

  await db.delete(categories).where(eq(categories.id, id));
  await audit(req, { action: 'category.delete', entityType: 'category', entityId: id, before });
  res.status(204).end();
});
