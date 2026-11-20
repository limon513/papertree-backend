import { Router } from 'express';
import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { adminUsers, customers, orders, quotations } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { bdPhone, normalizePhone } from '../../../lib/phone.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { quotationEmail, quotationLink, quotationMessages, quotationSms } from '../../quotations/messages.ts';
import { createQuotation, quotationWithItems, quoteNumber } from '../../quotations/service.ts';
import { isApprovedBusiness } from '../customers/service.ts';
import { sendEmail, sendSms } from '../integrations/service.ts';
import { emailSchema, nameSchema } from '../schemas.ts';

/** Quotations made on the website and by staff. Mounted behind requireAdmin + requireModule('orders'). */
export const quotationsRouter = Router();

const PAGE_SIZE = 50;
const STATUS = ['open', 'expired', 'ordered', 'cancelled', 'replaced', 'all'] as const;
export const quotationListQuery = z.object({
  search: z.string().trim().max(100).optional().meta({ description: 'Quotation number (Q-1001 or 1001), phone, name or organisation' }),
  status: z.enum(STATUS).default('all').meta({ description: 'open = still valid; expired = open but past its date' }),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

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
  const [[by], messages] = await Promise.all([
    q.createdBy ? db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, q.createdBy)) : Promise.resolve([]),
    quotationMessages(q.number),
  ]);
  const { publicToken, createdBy: _c, ...rest } = q;
  return {
    ...rest,
    number: quoteNumber(q.number),
    status: view.status,
    createdByName: by?.name ?? null,
    /** The quotation's page on the website (to open or send to the customer). */
    link: quotationLink(publicToken),
    items: view.items,
    order: view.order ? { id: view.order.id, number: view.order.number } : null,
    /** The newer version (when replaced), and the one this replaces. */
    replacedBy: view.replacedBy ? { id: view.replacedBy.id, number: quoteNumber(view.replacedBy.number) } : null,
    replaces: view.replaces ? { id: view.replaces.id, number: quoteNumber(view.replaces.number) } : null,
    /** SMS and emails it was sent with. */
    messages,
  };
}

// ---- Staff quotations ----

const optional = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().default(null);
export const staffQuotationBody = z
  .object({
    type: z.enum(['retail', 'wholesale']).default('retail').meta({ description: 'wholesale: wholesale prices; only for an approved business' }),
    /** A known customer (else found by phone, if any). */
    customerId: z.number().int().positive().nullable().default(null),
    name: nameSchema,
    organisation: optional(150),
    phone: bdPhone,
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    note: optional(500).meta({ description: 'Their reference' }),
    terms: optional(2000).meta({ description: 'Shown on the quotation' }),
    validDays: z.number().int().min(1, { error: 'At least 1 day' }).max(90, { error: 'At most 90 days' }).default(7),
    deliveryFee: z.number().min(0).max(100_000).nullable().default(null).meta({ description: 'Fixed delivery (0 = free); null = worked out when ordering' }),
    items: z
      .array(
        z.object({
          variantId: z.number().int().positive(),
          quantity: z.number({ error: 'Enter the quantity' }).int({ error: 'Whole pieces only' }).min(1, { error: 'At least 1' }).max(99_999, { error: 'Too many' }),
          /** A special price per piece. Left out: the product's price (and bulk discounts, retail). */
          unitPrice: z.number({ error: 'Enter the price' }).min(0, { error: 'Not below 0' }).max(10_000_000).optional(),
          bulk: z.boolean().optional(),
        }),
      )
      .min(1, { error: 'Add at least one product' })
      .max(100, { error: 'At most 100 lines' }),
  })
  .meta({ id: 'StaffQuotationBody' });

/** Whose quotation: the chosen customer, else the one with this phone. Wholesale needs an approved business. */
async function ownerOf(input: z.infer<typeof staffQuotationBody>) {
  const [c] = input.customerId
    ? await db.select().from(customers).where(eq(customers.id, input.customerId))
    : await db.select().from(customers).where(eq(customers.phone, input.phone));
  if (input.customerId && !c) throw badRequest('This customer no longer exists', { customerId: 'Not found' });
  if (input.type === 'wholesale' && !isApprovedBusiness(c)) {
    throw badRequest('Wholesale prices are for approved business customers. Choose retail, or approve the business first.', { type: 'Not an approved business' });
  }
  return c?.id ?? null;
}

/** A quotation made by staff: their prices (or the products' prices), validity, delivery and terms. */
quotationsRouter.post('/', async (req, res) => {
  const input = staffQuotationBody.parse(req.body);
  const admin = currentAdmin(req);
  const q = await createQuotation(input, { type: input.type, customerId: await ownerOf(input), source: 'staff', adminUserId: admin.id });
  await audit(req, { action: 'quotation.create', entityType: 'quotation', entityId: q.id, after: { number: quoteNumber(q.number) } });
  res.status(201).json(await detail(q.id));
});

/** A new version of an open (or expired) quotation: the old one becomes "replaced" and can no longer be ordered. */
quotationsRouter.post('/:id/revise', async (req, res) => {
  const id = parseId(req.params.id);
  const input = staffQuotationBody.parse(req.body);
  const admin = currentAdmin(req);
  const q = await createQuotation(input, { type: input.type, customerId: await ownerOf(input), source: 'staff', adminUserId: admin.id, replaces: id });
  await audit(req, { action: 'quotation.revise', entityType: 'quotation', entityId: q.id, after: { number: quoteNumber(q.number), replaces: id } });
  res.status(201).json(await detail(q.id));
});

/** The SMS and email as the customer will get them (before sending). */
quotationsRouter.get('/:id/message', async (req, res) => {
  const [q] = await db.select().from(quotations).where(eq(quotations.id, parseId(req.params.id)));
  if (!q) throw notFound('Quotation not found');
  const email = await quotationEmail(q);
  res.json({ phone: q.phone, email: q.email, sms: await quotationSms(q), emailSubject: email.subject, emailHtml: email.html });
});

export const quotationSendBody = z
  .object({ sms: z.boolean().default(false), email: z.boolean().default(false) })
  .refine((b) => b.sms || b.email, { error: 'Choose SMS, email or both' })
  .meta({ id: 'QuotationSend' });

/** Sends the quotation's link to the customer by SMS and/or email (only an open one). */
quotationsRouter.post('/:id/send', async (req, res) => {
  const id = parseId(req.params.id);
  const input = quotationSendBody.parse(req.body);
  const [q] = await db.select().from(quotations).where(eq(quotations.id, id));
  if (!q) throw notFound('Quotation not found');
  if (q.status !== 'open' || q.validUntil < new Date()) throw badRequest('Only an open quotation can be sent. Revise it to send a new version.');
  if (input.email && !q.email) throw badRequest('This quotation has no email address. Send it by SMS, or revise it with an email.');
  const purpose = `quote.sent ${quoteNumber(q.number)}`;
  const results: { channel: 'sms' | 'email'; status: string; error: string | null }[] = [];
  if (input.sms) {
    const r = await sendSms({ to: q.phone, text: await quotationSms(q), purpose });
    results.push({ channel: 'sms', status: r.status, error: r.error });
  }
  if (input.email) {
    const r = await sendEmail({ to: q.email!, ...(await quotationEmail(q)), purpose });
    results.push({ channel: 'email', status: r.status, error: r.error });
  }
  if (results.some((r) => r.status !== 'failed')) {
    await db.update(quotations).set({ sentAt: new Date(), timesSent: sql`${quotations.timesSent} + 1` }).where(eq(quotations.id, id));
  }
  await audit(req, { action: 'quotation.send', entityType: 'quotation', entityId: id, after: { results } });
  res.json({ results, quotation: await detail(id) });
});

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
    throw badRequest(q.status === 'ordered' ? 'This quotation is already ordered.' : q.status === 'replaced' ? 'This quotation was replaced by a newer version.' : 'This quotation is already cancelled.');
  }
  await audit(req, { action: 'quotation.cancel', entityType: 'quotation', entityId: id });
  res.json(await detail(id));
});
