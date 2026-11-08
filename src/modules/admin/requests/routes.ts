import { Router } from 'express';
import { count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, customers, productRequests } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { productRequestListQuery, productRequestUpdate } from './schemas.ts';

/** "Request this product" from the website. Mounted behind requireAdmin + requireModule('leads'). */
export const productRequestsRouter = Router();

const PAGE_SIZE = 50;

const select = () =>
  db
    .select({
      id: productRequests.id,
      name: productRequests.name,
      phone: productRequests.phone,
      details: productRequests.details,
      query: productRequests.query,
      status: productRequests.status,
      staffNote: productRequests.staffNote,
      handledBy: adminUsers.name,
      handledAt: productRequests.handledAt,
      createdAt: productRequests.createdAt,
      customerId: customers.id,
    })
    .from(productRequests)
    .leftJoin(adminUsers, eq(adminUsers.id, productRequests.handledBy))
    .leftJoin(customers, eq(customers.phone, productRequests.phone));

productRequestsRouter.get('/', async (req, res) => {
  const q = productRequestListQuery.parse(req.query);
  const where = q.status === 'all' ? undefined : eq(productRequests.status, q.status);
  const [items, totals, counted] = await Promise.all([
    select()
      .where(where)
      // New ones: oldest first (waiting longest). Done ones: latest first.
      .orderBy(q.status === 'new' ? sql`${productRequests.createdAt} asc` : desc(productRequests.createdAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(productRequests).where(where),
    db.select({ status: productRequests.status, n: count() }).from(productRequests).groupBy(productRequests.status),
  ]);
  const by = Object.fromEntries(counted.map((c) => [c.status, c.n]));
  res.json({ items, total: totals[0]?.total ?? 0, page: q.page, pageSize: PAGE_SIZE, counts: { new: by.new ?? 0, done: by.done ?? 0 } });
});

productRequestsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = productRequestUpdate.parse(req.body);
  const [before] = await db.select().from(productRequests).where(eq(productRequests.id, id));
  if (!before) throw notFound('Request not found');
  const done = input.status === 'done';
  await db
    .update(productRequests)
    .set({
      status: input.status,
      staffNote: input.staffNote,
      // Who handled it, kept from the first time it was marked done.
      handledBy: done ? (before.handledBy ?? req.admin!.id) : null,
      handledAt: done ? (before.handledAt ?? new Date()) : null,
    })
    .where(eq(productRequests.id, id));
  await audit(req, { action: 'product_request.update', entityType: 'product_request', entityId: id, before: { status: before.status, staffNote: before.staffNote }, after: input });
  const [row] = await select().where(eq(productRequests.id, id));
  res.json(row);
});
