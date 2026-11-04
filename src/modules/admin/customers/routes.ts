import { Router } from 'express';
import { and, asc, count, desc, eq, ilike, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { customerAddresses, customers, orders } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { normalizePhone } from '../../../lib/phone.ts';
import { AREAS, DISTRICTS } from '../settings/service.ts';
import { addressBody, blockBody, businessBody, customerBody, customerListQuery, type AddressInput } from './schemas.ts';
import { addressView, setDefaultAddress } from './service.ts';

/** Mounted behind requireAdmin + requireModule('customers'). */
export const customersRouter = Router();

const PAGE_SIZE = 50;

/** Orders and spending per customer. Cancelled orders do not count. */
const statsByCustomer = () =>
  db
    .select({
      customerId: orders.customerId,
      orders: sql<number>`count(*) filter (where ${orders.status} <> 'cancelled')`.as('orders_count'),
      spent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} = 'delivered'), 0)`.as('spent'),
      due: sql<number>`coalesce(sum(greatest(${orders.total} - ${orders.paidAmount}, 0)) filter (where ${orders.status} not in ('cancelled', 'returned')), 0)`.as(
        'due',
      ),
      lastOrderAt: sql<Date | null>`max(${orders.createdAt})`.as('last_order_at'),
    })
    .from(orders)
    .where(isNotNull(orders.customerId))
    .groupBy(orders.customerId)
    .as('s');

const VIEWS: Record<string, SQL | undefined> = {
  all: undefined,
  retail: eq(customers.type, 'retail'),
  business: and(eq(customers.type, 'business'), eq(customers.businessStatus, 'approved')),
  pending: eq(customers.businessStatus, 'pending'),
  blocked: eq(customers.isBlocked, true),
};

customersRouter.get('/', async (req, res) => {
  const q = customerListQuery.parse(req.query);
  const s = statsByCustomer();

  const search = q.search;
  const searchFilter = search
    ? or(
        ilike(customers.name, `%${search}%`),
        ilike(customers.phone, `%${normalizePhone(search)}%`),
        ilike(customers.email, `%${search}%`),
        ilike(customers.businessName, `%${search}%`),
      )
    : undefined;
  const where = and(searchFilter, VIEWS[q.view]);

  const orderBy = {
    newest: [desc(customers.createdAt)],
    last_order: [sql`${s.lastOrderAt} desc nulls last`, desc(customers.createdAt)],
    spent: [sql`coalesce(${s.spent}, 0) desc`, desc(customers.createdAt)],
    orders: [sql`coalesce(${s.orders}, 0) desc`, desc(customers.createdAt)],
    name: [asc(sql`lower(${customers.name})`)],
  }[q.sort];

  const [rows, [total], ...counts] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        type: customers.type,
        businessName: customers.businessName,
        businessStatus: customers.businessStatus,
        isBlocked: customers.isBlocked,
        createdAt: customers.createdAt,
        orders: sql<number>`coalesce(${s.orders}, 0)`.mapWith(Number),
        spent: sql<number>`coalesce(${s.spent}, 0)`.mapWith(Number),
        due: sql<number>`coalesce(${s.due}, 0)`.mapWith(Number),
        lastOrderAt: s.lastOrderAt,
      })
      .from(customers)
      .leftJoin(s, eq(s.customerId, customers.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(customers).where(where),
    ...Object.entries(VIEWS).map(([view, filter]) =>
      db
        .select({ view: sql<string>`${view}`, n: count() })
        .from(customers)
        .where(and(searchFilter, filter)),
    ),
  ]);

  res.json({
    items: rows.map((r) => ({ ...r, lastOrderAt: r.lastOrderAt ? new Date(r.lastOrderAt) : null })),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: PAGE_SIZE,
    counts: Object.fromEntries(counts.map(([c]) => [c!.view, c!.n])),
  });
});

async function getCustomer(id: number) {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  if (!row) throw notFound('Customer not found');
  return row;
}

async function customerView(id: number) {
  const customer = await getCustomer(id);
  const [[stats], addresses, recent] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*) filter (where ${orders.status} <> 'cancelled')`.mapWith(Number),
        spent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} = 'delivered'), 0)`.mapWith(Number),
        delivered: sql<number>`count(*) filter (where ${orders.status} = 'delivered')`.mapWith(Number),
        due: sql<number>`coalesce(sum(greatest(${orders.total} - ${orders.paidAmount}, 0)) filter (where ${orders.status} not in ('cancelled', 'returned')), 0)`.mapWith(
          Number,
        ),
        cancelled: sql<number>`count(*) filter (where ${orders.status} = 'cancelled')`.mapWith(Number),
        returned: sql<number>`count(*) filter (where ${orders.status} = 'returned')`.mapWith(Number),
        lastOrderAt: sql<string | null>`max(${orders.createdAt})`,
      })
      .from(orders)
      .where(eq(orders.customerId, id)),
    db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, id))
      .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.updatedAt)),
    db
      .select({
        id: orders.id,
        number: orders.number,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        type: orders.type,
        total: orders.total,
        paidAmount: orders.paidAmount,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.customerId, id))
      .orderBy(desc(orders.createdAt))
      .limit(50),
  ]);
  const s = stats!;
  return {
    ...customer,
    stats: {
      orders: s.orders,
      spent: s.spent,
      due: s.due,
      cancelled: s.cancelled,
      returned: s.returned,
      averageOrder: s.delivered ? Math.round(s.spent / s.delivered) : 0,
      lastOrderAt: s.lastOrderAt ? new Date(s.lastOrderAt) : null,
    },
    addresses: addresses.map(addressView),
    orders: recent,
  };
}

customersRouter.get('/:id', async (req, res) => {
  res.json(await customerView(parseId(req.params.id)));
});

async function checkPhone(phone: string, exceptId?: number) {
  const [row] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(exceptId ? and(eq(customers.phone, phone), ne(customers.id, exceptId)) : eq(customers.phone, phone));
  if (row) {
    const message = `This number belongs to ${row.name}`;
    throw conflict(message, { phone: message, customerId: String(row.id) });
  }
}

customersRouter.post('/', async (req, res) => {
  const input = customerBody.parse(req.body);
  await checkPhone(input.phone);
  const [row] = await db
    .insert(customers)
    .values({ ...input, businessStatus: input.type === 'business' ? 'approved' : null })
    .returning({ id: customers.id });
  await audit(req, { action: 'customer.create', entityType: 'customer', entityId: row!.id, after: input });
  res.status(201).json(await customerView(row!.id));
});

customersRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getCustomer(id);
  const input = customerBody.parse(req.body);
  await checkPhone(input.phone, id);
  // Turning someone into a business by hand approves them; back to retail clears it.
  const businessStatus = input.type === 'business' ? (before.businessStatus ?? 'approved') : null;
  await db.update(customers).set({ ...input, businessStatus }).where(eq(customers.id, id));
  await audit(req, { action: 'customer.update', entityType: 'customer', entityId: id, before, after: input });
  res.json(await customerView(id));
});

/** Approve or reject a business, and set its own wholesale terms. */
customersRouter.put('/:id/business', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getCustomer(id);
  const input = businessBody.parse(req.body);
  if (input.status === 'approved' && !before.businessName) {
    throw badRequest('Add the business name first (Edit details)');
  }
  const terms = input.terms && Object.values(input.terms).some((v) => v !== null) ? input.terms : null;
  await db
    .update(customers)
    .set({ type: input.status === 'approved' ? 'business' : before.type, businessStatus: input.status, wholesaleTerms: terms })
    .where(eq(customers.id, id));
  await audit(req, { action: 'customer.business', entityType: 'customer', entityId: id, before, after: { ...input, terms } });
  res.json(await customerView(id));
});

customersRouter.put('/:id/block', async (req, res) => {
  const id = parseId(req.params.id);
  await getCustomer(id);
  const input = blockBody.parse(req.body);
  await db
    .update(customers)
    .set({ isBlocked: input.blocked, blockedReason: input.blocked ? input.reason : null })
    .where(eq(customers.id, id));
  await audit(req, { action: input.blocked ? 'customer.block' : 'customer.unblock', entityType: 'customer', entityId: id, after: input });
  res.json(await customerView(id));
});

// ---- Addresses ----

function checkPlace(input: AddressInput) {
  if (!DISTRICTS.has(input.districtId)) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  if (input.areaId && AREAS.get(input.areaId)?.districtId !== input.districtId) {
    throw badRequest('Choose an area in this district', { areaId: 'Choose an area in this district' });
  }
}

async function getAddress(customerId: number, addressId: number) {
  const [row] = await db
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)));
  if (!row) throw notFound('Address not found');
  return row;
}

customersRouter.post('/:id/addresses', async (req, res) => {
  const id = parseId(req.params.id);
  await getCustomer(id);
  const input = addressBody.parse(req.body);
  checkPlace(input);
  await db.transaction(async (tx) => {
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(customerAddresses).where(eq(customerAddresses.customerId, id));
    const [row] = await tx
      .insert(customerAddresses)
      .values({ ...input, customerId: id, isDefault: false })
      .returning({ id: customerAddresses.id });
    if (input.isDefault || n === 0) await setDefaultAddress(tx, id, row!.id);
  });
  res.status(201).json(await customerView(id));
});

customersRouter.put('/:id/addresses/:addressId', async (req, res) => {
  const id = parseId(req.params.id);
  const addressId = parseId(req.params.addressId);
  const before = await getAddress(id, addressId);
  const input = addressBody.parse(req.body);
  checkPlace(input);
  await db.transaction(async (tx) => {
    await tx
      .update(customerAddresses)
      .set({ ...input, isDefault: before.isDefault })
      .where(eq(customerAddresses.id, addressId));
    if (input.isDefault && !before.isDefault) await setDefaultAddress(tx, id, addressId);
  });
  res.json(await customerView(id));
});

customersRouter.delete('/:id/addresses/:addressId', async (req, res) => {
  const id = parseId(req.params.id);
  const address = await getAddress(parseId(req.params.id), parseId(req.params.addressId));
  await db.transaction(async (tx) => {
    await tx.delete(customerAddresses).where(eq(customerAddresses.id, address.id));
    // Keep a default when other addresses are left.
    if (address.isDefault) {
      const [next] = await tx
        .select({ id: customerAddresses.id })
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, id))
        .orderBy(desc(customerAddresses.updatedAt))
        .limit(1);
      if (next) await setDefaultAddress(tx, id, next.id);
    }
  });
  res.json(await customerView(id));
});
