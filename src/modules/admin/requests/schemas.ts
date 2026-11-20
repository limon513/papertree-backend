import { z } from 'zod';

export const productRequestListQuery = z.object({
  status: z.enum(['new', 'done', 'all']).default('new'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const productRequestUpdate = z
  .object({
    status: z.enum(['new', 'done']),
    staffNote: z.string().trim().max(1000).nullable().default(null),
  })
  .meta({ id: 'ProductRequestUpdate', example: { status: 'done', staffNote: 'Ordered from supplier, called back' } });

export const productRequestView = z
  .object({
    id: z.number(),
    name: z.string(),
    phone: z.string(),
    details: z.string(),
    query: z.string().nullable(),
    status: z.enum(['new', 'done']),
    staffNote: z.string().nullable(),
    handledBy: z.string().nullable().meta({ description: 'Staff name' }),
    handledAt: z.date().nullable(),
    createdAt: z.date(),
    /** A customer with this phone number, if any. */
    customerId: z.number().nullable(),
  })
  .meta({ id: 'ProductRequest' });

export const productRequestList = z
  .object({
    items: z.array(productRequestView),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    counts: z.object({ new: z.number(), done: z.number() }),
  })
  .meta({ id: 'ProductRequestList' });

// ---- "Sell with us" supplier leads ----

const supplierStatus = z.enum(['new', 'talking', 'done']);

export const supplierLeadListQuery = z.object({
  status: z.enum(['new', 'talking', 'done', 'all']).default('new'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const supplierLeadUpdate = z
  .object({
    status: supplierStatus.meta({ description: 'new, talking (in talks), done' }),
    staffNote: z.string().trim().max(1000).nullable().default(null),
  })
  .meta({ id: 'SupplierLeadUpdate', example: { status: 'done', staffNote: 'Agreed: 15 products, they deliver to our shop' } });

export const supplierLeadView = z
  .object({
    id: z.number(),
    businessName: z.string(),
    contactName: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    location: z.string().nullable(),
    products: z.string(),
    ways: z.array(z.enum(['wholesale', 'brand', 'unsure'])),
    link: z.string().nullable(),
    message: z.string().nullable(),
    status: supplierStatus,
    staffNote: z.string().nullable(),
    handledBy: z.string().nullable().meta({ description: 'Staff name' }),
    handledAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .meta({ id: 'SupplierLead' });

export const supplierLeadList = z
  .object({
    items: z.array(supplierLeadView),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    counts: z.object({ new: z.number(), talking: z.number(), done: z.number() }),
  })
  .meta({ id: 'SupplierLeadList' });
