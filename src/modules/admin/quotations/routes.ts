import { Router } from 'express';
import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { adminUsers, orders, quotations } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { normalizePhone } from '../../../lib/phone.ts';
import { quotationWithItems, quoteNumber } from '../../quotations/service.ts';

/** Quotations made on the website (and later by staff). Mounted behind requireAdmin + requireModule('orders'). */
export const quotationsRouter = Router();

const PAGE_SIZE = 50;
const STATUS = ['open', 'expired', 'ordered', 'cancelled', 'all'] as const;
export const quotationListQuery = z.object({
  search: z.string().trim().max(100).optional().meta({ description: 'Quotation number (Q-1001 or 1001), phone, name or organisation' }),
  status: z.enum(STATUS).default('all').meta({ description: 'open = still valid; expired = open but past its date' }),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const link = (token: string) => `${env.STOREFRONT_URL.replace(/\/$/, '')}/quotation/${token}/`;
const now = () => new Date();
const byStatus = (s: (typeof STATUS)[number]): SQL | undefined =>
  s === 'open'
    ? and(eq(quotations.status, 'open'), gte(quotations.validUntil, now()))
    : s === 'expired'
      ? and(eq(quotations.status, 'open'), lt(quotations.validUntil, now()))
      : s === 'all'
        ? undefined
        : eq(quotations.status, s);

quotationsRouter.get('/', async (req, res) => {
  const q = quotationListQuery.parse(req.query);
  const term = q.search?.replace(/^q-?/i, '').replace(/^#/, '');
  const search = term
    ? or(
        /^\d{4,7}$/.test(term) ? eq(quotations.number, Number(term)) : undefined,
        /^[\d+\s-]{6,}$/.test(term) ? ilike(quotations.phone, `%${normalizePhone(term)}%`) : undefined,
        ilike(quotations.name, `%${term}%`),
        ilike(quotations.organisation, `%${term}%`),
      )
    : undefined;
  const where = and(search, byStatus(q.status));
  const [rows, [total], counts] = await Promise.all([
    db
      .select({
        id: quotations.id,
        number: quotations.number,
        source: quotations.source,
        type: quotations.type,
        status: quotations.status,
        name: quotations.name,
        organisation: quotations.organisation,
        phone: quotations.phone,
        subtotal: quotations.subtotal,
        items: sql<number>`(select coalesce(sum(qi.quantity), 0) from quotation_items qi where qi.quotation_id = "quotations"."id")`.mapWith(Number),
        validUntil: quotations.validUntil,
        createdAt: quotations.createdAt,
        orderId: quotations.orderId,
        orderNumber: orders.number,
      })
      .from(quotations)
      .leftJoin(orders, eq(orders.id, quotations.orderId))
      .where(where)
      .orderBy(desc(quotations.createdAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(quotations).where(where),
    Promise.all(STATUS.filter((s) => s !== 'all').map(async (s) => [s, (await db.select({ n: count() }).from(quotations).where(and(search, byStatus(s))))[0]?.n ?? 0] as const)),
  ]);
  const at = now();
  res.json({
    items: rows.map((r) => ({ ...r, number: quoteNumber(r.number), status: r.status === 'open' && r.validUntil < at ? 'expired' : r.status })),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: PAGE_SIZE,
    counts: Object.fromEntries(counts),
  });
});

async function detail(id: number) {
  const view = await quotationWithItems(eq(quotations.id, id));
  if (!view) throw notFound('Quotation not found');
  const q = view.quotation;
  const [by] = q.createdBy ? await db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, q.createdBy)) : [];
  const { publicToken, createdBy: _c, ...rest } = q;
  return {
    ...rest,
    number: quoteNumber(q.number),
    status: view.status,
    createdByName: by?.name ?? null,
    /** The quotation's page on the website (to open or send to the customer). */
    link: link(publicToken),
    items: view.items,
    order: view.order ? { id: view.order.id, number: view.order.number } : null,
  };
}

quotationsRouter.get('/:id', async (req, res) => {
  res.json(await detail(parseId(req.params.id)));
});

/** Cancel an open quotation: it can no longer be ordered. */
quotationsRouter.post('/:id/cancel', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db
    .update(quotations)
    .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(quotations.id, id), eq(quotations.status, 'open')))
    .returning({ id: quotations.id });
  if (!row) {
    const [q] = await db.select({ status: quotations.status }).from(quotations).where(eq(quotations.id, id));
    if (!q) throw notFound('Quotation not found');
    throw badRequest(q.status === 'ordered' ? 'This quotation is already ordered.' : 'This quotation is already cancelled.');
  }
  await audit(req, { action: 'quotation.cancel', entityType: 'quotation', entityId: id });
  res.json(await detail(id));
});
