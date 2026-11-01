import { Router } from 'express';
import { and, asc, eq, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { brands } from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { createBrandBody, updateBrandBody } from './schemas.ts';

/** Mounted behind requireAdmin + requireModule('products'). */
export const brandsRouter = Router();

async function getBrand(id: number) {
  const [row] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!row) throw notFound('Brand not found');
  return row;
}

async function checkName(name: string, exceptId?: number) {
  const sameName = sql`lower(${brands.name}) = ${name.toLowerCase()}`;
  const [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(exceptId ? and(sameName, ne(brands.id, exceptId)) : sameName)
    .limit(1);
  if (row) {
    const message = 'A brand with this name already exists';
    throw conflict(message, { name: message });
  }
}

/** Uses the given slug (must be free) or makes a free one from the name. */
async function pickSlug(given: string | undefined, name: string, exceptId?: number) {
  const base = given || slugify(name);
  if (!base) throw badRequest('Enter a URL name', { slug: 'Enter a URL name using letters or numbers' });

  const similar = await db
    .select({ id: brands.id, name: brands.name, slug: brands.slug })
    .from(brands)
    .where(or(eq(brands.slug, base), like(brands.slug, `${base}-%`)));
  const others = similar.filter((b) => b.id !== exceptId);

  if (given) {
    const owner = others.find((b) => b.slug === given);
    if (owner) {
      const message = `This URL name is already used by "${owner.name}"`;
      throw conflict(message, { slug: message });
    }
    return given;
  }
  return freeSlug(base, new Set(others.map((b) => b.slug)));
}

brandsRouter.get('/', async (_req, res) => {
  res.json({ items: await db.select().from(brands).orderBy(asc(sql`lower(${brands.name})`)) });
});

brandsRouter.get('/:id', async (req, res) => {
  res.json(await getBrand(parseId(req.params.id)));
});

brandsRouter.post('/', async (req, res) => {
  const input = createBrandBody.parse(req.body);
  await checkName(input.name);

  const [created] = await db
    .insert(brands)
    .values({
      name: input.name,
      slug: await pickSlug(input.slug, input.name),
      description: input.description ?? null,
      isActive: input.isActive,
      isFeatured: input.isFeatured,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
    })
    .returning();

  await audit(req, { action: 'brand.create', entityType: 'brand', entityId: created!.id, after: created });
  res.status(201).json(created);
});

brandsRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = updateBrandBody.parse(req.body);
  const before = await getBrand(id);

  if (input.name !== undefined) await checkName(input.name, id);
  const name = input.name ?? before.name;

  const [after] = await db
    .update(brands)
    .set({
      name: input.name,
      // An empty slug means "make a new one from the name".
      slug: input.slug === undefined ? undefined : await pickSlug(input.slug, name, id),
      description: input.description,
      isActive: input.isActive,
      isFeatured: input.isFeatured,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
    })
    .where(eq(brands.id, id))
    .returning();

  await audit(req, { action: 'brand.update', entityType: 'brand', entityId: id, before, after });
  res.json(after);
});

brandsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getBrand(id);

  await db.delete(brands).where(eq(brands.id, id));
  await audit(req, { action: 'brand.delete', entityType: 'brand', entityId: id, before });
  res.status(204).end();
});
