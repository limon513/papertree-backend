import { boolean, index, numeric, pgTable, primaryKey } from 'drizzle-orm/pg-core';
import { customers } from './customers.ts';
import { products } from './products.ts';
import { ref, timestamptz } from './_helpers.ts';

/**
 * A customer's saved products (the heart). One row per customer and product. The price and stock when
 * saved let the shop say "cheaper since you saved it" / "back in stock", and send those alerts later.
 */
export const wishlistItems = pgTable(
  'wishlist_items',
  {
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    productId: ref('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** The lowest price shown for the product when saved. */
    priceWhenSaved: numeric('price_when_saved', { precision: 12, scale: 2, mode: 'number' }),
    inStockWhenSaved: boolean('in_stock_when_saved').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.productId] }), index('wishlist_items_product_id_idx').on(t.productId)],
);
