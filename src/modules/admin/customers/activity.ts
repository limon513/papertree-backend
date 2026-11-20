import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { imagesById } from '../../store/catalog.ts';

/**
 * A customer's activity for staff (the last 90 days): when they come and on what, what they look at,
 * what they search for, the categories they like, and staff who logged in as them.
 */
export async function customerActivityView(customerId: number) {
  const [summary, devices, products, searches, categories, staff] = await Promise.all([
    db.execute<{ last30: number; last90: number }>(sql`
      select count(*) filter (where created_at > now() - interval '30 days')::int as last30, count(*)::int as last90
      from customer_activity where customer_id = ${customerId} and kind = 'visit'`),
    db.execute<{ device: string; visits: number; last: Date }>(sql`
      select device, count(*)::int as visits, max(created_at) as last
      from customer_activity where customer_id = ${customerId} and kind = 'visit' and device is not null
      group by device order by max(created_at) desc limit 5`),
    db.execute<{ id: string; name: string; slug: string; image_id: string | null; views: number; last: Date }>(sql`
      select p.id, p.name, p.slug, count(*)::int as views, max(a.created_at) as last,
        (select pi.media_id from product_images pi where pi.product_id = p.id order by pi.position limit 1) as image_id
      from customer_activity a join products p on p.id = a.product_id
      where a.customer_id = ${customerId} and a.kind = 'product'
      group by p.id order by max(a.created_at) desc limit 12`),
    db.execute<{ query: string; times: number; last: Date }>(sql`
      select query, count(*)::int as times, max(created_at) as last
      from customer_activity where customer_id = ${customerId} and kind = 'search' and query is not null
      group by query order by max(created_at) desc limit 15`),
    db.execute<{ name: string; views: number }>(sql`
      select c.name, count(*)::int as views
      from customer_activity a
      join product_categories pc on pc.product_id = a.product_id and pc.is_primary
      join categories c on c.id = pc.category_id
      where a.customer_id = ${customerId} and a.kind = 'product'
      group by c.name order by count(*) desc limit 5`),
    db.execute<{ name: string | null; at: Date }>(sql`
      select u.name, l.created_at as at
      from audit_logs l left join admin_users u on u.id = l.admin_user_id
      where l.action = 'customer.login_as' and l.entity_type = 'customer' and l.entity_id = ${String(customerId)}
      order by l.created_at desc limit 10`),
  ]);
  const images = await imagesById(products.rows.map((p) => (p.image_id ? Number(p.image_id) : null)));
  return {
    days: 90,
    visits: { last30: summary.rows[0]?.last30 ?? 0, last90: summary.rows[0]?.last90 ?? 0 },
    devices: devices.rows,
    products: products.rows.map((p) => ({ id: Number(p.id), name: p.name, slug: p.slug, image: p.image_id ? (images.get(Number(p.image_id)) ?? null) : null, views: p.views, last: p.last })),
    searches: searches.rows,
    categories: categories.rows,
    /** Staff who logged in as this customer (from the audit log). */
    staffLogins: staff.rows,
  };
}
