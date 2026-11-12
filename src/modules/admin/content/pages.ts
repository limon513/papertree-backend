import { Router } from 'express';
import { asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { pages } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { cleanHtml, decodeEntities, htmlToText } from '../../../lib/html.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { FetchError, fetchPublic } from '../../../lib/safe-fetch.ts';
import { slugify } from '../../../lib/slug.ts';
import { addressChanged, addressesInUse } from '../seo/service.ts';
import { seoFields } from '../schemas.ts';

/** Content pages (About, Contact, Terms...). Mounted behind requireAdmin + requireModule('content'). */
export const pagesRouter = Router();

/** Addresses the website already uses for its own pages. */
const RESERVED = new Set([
  'shop', 'cart', 'checkout', 'account', 'search', 'product', 'product-category', 'brand', 'brands', 'categories', 'deals', 'new',
  'sitemap', 'robots', 'api', 'admin', '404', '500', '_astro', 'icons', 'uploads', 'my-account', 'wishlist', 'compare',
]);

export const pageBody = z
  .object({
    title: z.string({ error: 'Enter a title' }).trim().min(2, { error: 'Enter a title' }).max(150),
    slug: z.string().trim().max(200).optional().meta({ description: 'Address: /<slug>/. Empty: made from the title.' }),
    body: z.string().max(500_000).nullable().default(null),
    seoTitle: seoFields.seoTitle.default(null),
    seoDescription: seoFields.seoDescription.default(null),
    isPublished: z.boolean().default(false),
    showInFooter: z.boolean().default(true),
    showContact: z.boolean().default(false),
  })
  .meta({ id: 'PageBody' });

/**
 * A page address. Like other addresses, but underscores are kept: old WordPress pages use them
 * (/refund_returns/), and changing them would lose the old link.
 */
const pageSlug = (text: string) =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .slice(0, 200)
    .replace(/^[-_]+|[-_]+$/g, '');

async function pickSlug(given: string | undefined, title: string, id?: number) {
  const slug = given ? pageSlug(given) : slugify(title, 200);
  if (!slug) throw badRequest('Enter an address using letters or numbers', { slug: 'Letters or numbers' });
  if (RESERVED.has(slug)) throw badRequest(`/${slug}/ is one of the website's own pages`, { slug: 'Used by the website' });
  const [owner] = await db.select({ id: pages.id }).from(pages).where(eq(pages.slug, slug));
  if (owner && owner.id !== id) throw conflict('Another page has this address', { slug: 'Another page has this address' });
  return slug;
}

const values = (input: z.infer<typeof pageBody>) => ({
  title: input.title,
  body: input.body ? cleanHtml(input.body) : null,
  seoTitle: input.seoTitle,
  seoDescription: input.seoDescription,
  isPublished: input.isPublished,
  showInFooter: input.showInFooter,
  showContact: input.showContact,
});

pagesRouter.get('/', async (_req, res) => {
  res.json({ items: await db.select().from(pages).orderBy(asc(pages.sortOrder), asc(pages.id)) });
});

pagesRouter.get('/:id', async (req, res) => {
  const [row] = await db.select().from(pages).where(eq(pages.id, parseId(req.params.id)));
  if (!row) throw notFound('Page not found');
  res.json(row);
});

pagesRouter.post('/', async (req, res) => {
  const input = pageBody.parse(req.body);
  const slug = await pickSlug(input.slug, input.title);
  const [{ last } = { last: 0 }] = await db.select({ last: max(pages.sortOrder) }).from(pages);
  const [row] = await db.insert(pages).values({ ...values(input), slug, sortOrder: (last ?? 0) + 1 }).returning();
  // A real page lives at this address now: an old redirect from it would hide it.
  await addressesInUse(db, [`/${slug}/`]);
  await audit(req, { action: 'page.create', entityType: 'page', entityId: row!.id, after: { slug, title: row!.title } });
  res.status(201).json(row);
});

pagesRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = pageBody.parse(req.body);
  const [before] = await db.select().from(pages).where(eq(pages.id, id));
  if (!before) throw notFound('Page not found');
  const slug = input.slug === undefined ? before.slug : await pickSlug(input.slug, input.title, id);
  const [row] = await db.update(pages).set({ ...values(input), slug }).where(eq(pages.id, id)).returning();
  if (slug !== before.slug) await addressChanged(db, `/${before.slug}/`, `/${slug}/`);
  await audit(req, { action: 'page.update', entityType: 'page', entityId: id, before: { slug: before.slug, title: before.title, isPublished: before.isPublished }, after: { slug, title: row!.title, isPublished: row!.isPublished } });
  res.json(row);
});

pagesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db.delete(pages).where(eq(pages.id, id)).returning();
  if (!row) throw notFound('Page not found');
  await audit(req, { action: 'page.delete', entityType: 'page', entityId: id, before: { slug: row.slug, title: row.title } });
  res.status(204).end();
});

/** New order of the pages (footer order). */
pagesRouter.put('/', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(200) }).parse(req.body);
  await db.transaction(async (tx) => {
    for (const [i, pageId] of ids.entries()) await tx.update(pages).set({ sortOrder: i }).where(eq(pages.id, pageId));
  });
  res.json({ items: await db.select().from(pages).orderBy(asc(pages.sortOrder), asc(pages.id)) });
});

/** The old site's pages that are shop features here (cart, account...) or forms only: not copied. */
const NOT_COPIED = new Set(['shop', 'cart', 'checkout', 'my-account', 'wishlist', 'compare', 'home', 'home-base', 'order-tracking', 'product-request', 'blog', 'brands', 'sale-with-us', 'sample-page']);

/**
 * Copies the old WordPress site's content pages as drafts, with the same addresses (pictures are left
 * out: they would load from the old server). Pages already here are left alone. Contact: the shop's
 * details are shown from Settings instead of the old form.
 */
pagesRouter.post('/copy-old-site', async (req, res) => {
  const { site } = z.object({ site: z.string().trim().url().default('https://papertree.com.bd') }).parse(req.body ?? {});
  const origin = new URL(site).origin;
  let old: { slug: string; title: { rendered: string }; content: { rendered: string } }[];
  try {
    const got = await fetchPublic(`${origin}/wp-json/wp/v2/pages?per_page=100&_fields=slug,title,content`, { maxBytes: 20_000_000, timeoutMs: 60_000, accept: 'application/json' });
    old = JSON.parse(got.body.toString('utf8'));
    if (!Array.isArray(old)) throw new FetchError('Not a WordPress site');
  } catch (err) {
    throw badRequest(err instanceof FetchError ? `Could not read the old site: ${err.message}` : 'Could not read the old site');
  }
  const existing = new Set((await db.select({ slug: pages.slug }).from(pages)).map((p) => p.slug));
  const [{ last } = { last: 0 }] = await db.select({ last: max(pages.sortOrder) }).from(pages);
  let order = last ?? 0;
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const p of old) {
    const slug = pageSlug(p.slug ?? '');
    const contact = slug === 'contact-us' || slug === 'contact';
    const body = cleanHtml(p.content?.rendered ?? '', { copied: true }) ?? '';
    const text = htmlToText(body);
    if (!slug || NOT_COPIED.has(slug) || RESERVED.has(slug) || existing.has(slug) || (!contact && text.length < 40)) {
      skipped.push(slug);
      continue;
    }
    await db.insert(pages).values({
      slug,
      title: decodeEntities(p.title?.rendered ?? slug).slice(0, 150),
      // Contact: the old page was only a form; the shop's details are shown instead.
      body: contact ? null : body,
      isPublished: false,
      showInFooter: true,
      showContact: contact,
      sortOrder: ++order,
    });
    await addressesInUse(db, [`/${slug}/`]);
    copied.push(slug);
  }
  await audit(req, { action: 'page.copy-old-site', entityType: 'page', after: { copied, skipped: skipped.length } });
  res.json({ copied, skipped, items: await db.select().from(pages).orderBy(asc(pages.sortOrder), asc(pages.id)) });
});


