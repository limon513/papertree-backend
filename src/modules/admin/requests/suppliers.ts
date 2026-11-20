import { Router } from 'express';
import { count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, supplierLeads } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { supplierLeadListQuery, supplierLeadUpdate } from './schemas.ts';

/** "Sell with us" from the website. Mounted behind requireAdmin + requireModule('leads'). */
export const supplierLeadsRouter = Router();

const PAGE_SIZE = 50;

const select = () =>
  db
    .select({
      id: supplierLeads.id,
      businessName: supplierLeads.businessName,
      contactName: supplierLeads.contactName,
      phone: supplierLeads.phone,
      email: supplierLeads.email,
      location: supplierLeads.location,
      products: supplierLeads.products,
      ways: supplierLeads.ways,
      link: supplierLeads.link,
      message: supplierLeads.message,
      status: supplierLeads.status,
      staffNote: supplierLeads.staffNote,
      handledBy: adminUsers.name,
      handledAt: supplierLeads.handledAt,
      createdAt: supplierLeads.createdAt,
    })
    .from(supplierLeads)
    .leftJoin(adminUsers, eq(adminUsers.id, supplierLeads.handledBy));

supplierLeadsRouter.get('/', async (req, res) => {
  const q = supplierLeadListQuery.parse(req.query);
  const where = q.status === 'all' ? undefined : eq(supplierLeads.status, q.status);
  const [items, totals, counted] = await Promise.all([
    select()
      .where(where)
      // New ones: oldest first (waiting longest). Others: latest first.
      .orderBy(q.status === 'new' ? sql`${supplierLeads.createdAt} asc` : desc(supplierLeads.updatedAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(supplierLeads).where(where),
    db.select({ status: supplierLeads.status, n: count() }).from(supplierLeads).groupBy(supplierLeads.status),
  ]);
  const by = Object.fromEntries(counted.map((c) => [c.status, c.n]));
  res.json({ items, total: totals[0]?.total ?? 0, page: q.page, pageSize: PAGE_SIZE, counts: { new: by.new ?? 0, talking: by.talking ?? 0, done: by.done ?? 0 } });
});

supplierLeadsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = supplierLeadUpdate.parse(req.body);
  const [before] = await db.select().from(supplierLeads).where(eq(supplierLeads.id, id));
  if (!before) throw notFound('Lead not found');
  // Who picked it up (in talks or done), kept from the first time; cleared when back to new.
  const handled = input.status !== 'new';
  await db
    .update(supplierLeads)
    .set({
      status: input.status,
      staffNote: input.staffNote,
      handledBy: handled ? (before.handledBy ?? req.admin!.id) : null,
      handledAt: handled ? (before.handledAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(eq(supplierLeads.id, id));
  await audit(req, { action: 'supplier_lead.update', entityType: 'supplier_lead', entityId: id, before: { status: before.status, staffNote: before.staffNote }, after: input });
  const [row] = await select().where(eq(supplierLeads.id, id));
  res.json(row);
});
