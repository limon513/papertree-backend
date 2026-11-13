import { Router } from 'express';
import { and, asc, eq, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { labels, productLabels } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { labelBody, type LabelInput } from './schemas.ts';

/**
 * Tags shown on the website ("Overseas"...). Mounted behind requireAdmin + requireModule('products').
 * Products get them on their edit page or many at once (product list → Add tag).
 */
export const labelsRouter = Router();

const productCount = sql<number>`(select count(*) from ${productLabels} pl where pl.label_id = ${labels.id})`.mapWith(Number);
const listQuery = () =>
  db
    .select({
      id: labels.id,
      name: labels.name,
      slug: labels.slug,
      color: labels.color,
      showOnCards: labels.showOnCards,
      isActive: labels.isActive,
      sortOrder: labels.sortOrder,
      productCount,
      createdAt: labels.createdAt,
      updatedAt: labels.updatedAt,
    })
    .from(labels);

async function view(id: number) {
  const [row] = await listQuery().where(eq(labels.id, id));
  if (!row) throw notFound('Tag not found');
  return row;
}

async function checkName(name: string, exceptId?: number) {
  const same = sql`lower(${labels.name}) = ${name.toLowerCase()}`;
  const [row] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(exceptId ? and(same, ne(labels.id, exceptId)) : same);
  if (row) throw conflict('A tag with this name already exists', { name: 'A tag with this name already exists' });
}

/** The given slug (must be free), or a free one made from the name. */
async function pickSlug(given: string | undefined, name: string, exceptId?: number) {
  const base = given || slugify(name);
  if (!base) throw badRequest('Enter a name with letters or numbers', { name: 'Use letters or numbers' });
  const similar = await db
    .select({ id: labels.id, name: labels.name, slug: labels.slug })
    .from(labels)
    .where(or(eq(labels.slug, base), like(labels.slug, `${base}-%`)));
  const others = similar.filter((l) => l.id !== exceptId);
  if (given) {
    const owner = others.find((l) => l.slug === given);
    if (owner) throw conflict(`This link name is used by "${owner.name}"`, { slug: `Used by "${owner.name}"` });
    return given;
  }
  return freeSlug(base, new Set(others.map((l) => l.slug)));
}

const values = async (input: LabelInput, exceptId?: number) => ({
  name: input.name,
  slug: await pickSlug(input.slug, input.name, exceptId),
  color: input.color,
  showOnCards: input.showOnCards,
  isActive: input.isActive,
  sortOrder: input.sortOrder,
});

labelsRouter.get('/', async (_req, res) => {
  res.json({ items: await listQuery().orderBy(asc(labels.sortOrder), asc(sql`lower(${labels.name})`)) });
});

labelsRouter.post('/', async (req, res) => {
  const input = labelBody.parse(req.body);
  await checkName(input.name);
  const [row] = await db.insert(labels).values(await values(input)).returning({ id: labels.id });
  await audit(req, { action: 'label.create', entityType: 'label', entityId: row!.id, after: input });
  res.status(201).json(await view(row!.id));
});

labelsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await view(id);
  const input = labelBody.parse(req.body);
  await checkName(input.name, id);
  // Keep the link name unless a new one is typed (shared filter links keep working).
  await db
    .update(labels)
    .set({ ...(await values({ ...input, slug: input.slug ?? before.slug }, id)), updatedAt: new Date() })
    .where(eq(labels.id, id));
  await audit(req, { action: 'label.update', entityType: 'label', entityId: id, before, after: input });
  res.json(await view(id));
});

/** Removes the tag from the website and from every product that has it. */
labelsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await view(id);
  await db.delete(labels).where(eq(labels.id, id));
  await audit(req, { action: 'label.delete', entityType: 'label', entityId: id, before });
  res.status(204).end();
});
