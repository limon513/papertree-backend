import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errors, json, jsonBody } from '../../docs/common.ts';
import { locationsSchema } from '../admin/settings/schemas.ts';
import { trackBody } from './track.ts';
import { cartBody, checkoutBody, forYouQuery, productListQuery, productRequestBody,
  supplierLeadBody, searchLogBody, suggestQuery } from './schemas.ts';

const tags = ['Store (public)'];
const open = z.object({}).catchall(z.unknown());
const note = 'No sign-in. Only active products, categories and brands. Prices are today\'s retail prices; stock is at the default location.';

export const storeDocs: ZodOpenApiPathsObject = {
  '/v1/store/catalog': {
    get: {
      tags,
      summary: 'Menus and store details',
      description: `${note} Category tree (empty ones hidden) with product counts, brands, and the store details for the header and footer.`,
      responses: { '200': json(open.meta({ id: 'StoreCatalog' })) },
    },
  },
  '/v1/store/places': {
    get: {
      tags,
      summary: 'Districts and areas of Bangladesh',
      description: 'For "Deliver to" and address forms.',
      responses: { '200': json(locationsSchema) },
    },
  },
  '/v1/store/home': {
    get: {
      tags,
      summary: 'Home page rows',
      description: `${note} Banners shown now (hero slider up to 8, tiles up to 2), deals (biggest discount first), new arrivals, best sellers (last 90 days), "All products" (allProducts: 12, mixed from the main categories, none already in the rows above) and "Just for you" (forYou: 12 popular products; the website asks /for-you with the shopper's recent categories).`,
      responses: { '200': json(open.meta({ id: 'StoreHome' })) },
    },
  },
  '/v1/store/for-you': {
    get: {
      tags,
      summary: '"Just for you" products',
      description: `${note} Products in stock from the categories in like first, then the rest; the most bought first in each. 12 a page, the same order on every page.`,
      requestParams: { query: forYouQuery },
      responses: { '200': json(open.meta({ id: 'StoreForYou' })), ...errors(400) },
    },
  },
  '/v1/store/products': {
    get: {
      tags,
      summary: 'List products (category, brand, search, deals)',
      description:
        `${note} With the category (breadcrumbs, sub-categories) and filters: brands with counts and the price range. ` +
        'With q, "search" tells what was searched: typos fixed (corrected, searched), whether only some words matched (partial), and a product slug when q is exactly a SKU (sku).',
      requestParams: { query: productListQuery },
      responses: { '200': json(open.meta({ id: 'StoreProductList' })), ...errors(400, 404) },
    },
  },
  '/v1/store/popular-searches': {
    get: {
      tags,
      summary: 'Popular searches',
      description: `${note} The 8 most searched words in the last 30 days, only searches that found products, typos counted as the fixed word. Kept 10 minutes.`,
      responses: { '200': json(open.meta({ id: 'StorePopularSearches' })) },
    },
  },
  '/v1/store/suggest': {
    get: {
      tags,
      summary: 'Search as you type',
      description: `${note} Up to 6 products (best match first, typos fixed, synonyms used), 4 categories, 3 brands, and up to 5 suggested searches (terms: past searches that found products and start with the typed words).`,
      requestParams: { query: suggestQuery },
      responses: { '200': json(open.meta({ id: 'StoreSuggest' })), ...errors(400) },
    },
  },
  '/v1/store/products/{slug}': {
    get: {
      tags,
      summary: 'A product page',
      description: `${note} Images, variants with price and stock, specifications, breadcrumbs, and up to 12 related products in stock (from the same category, widened to its parent when it has fewer than 4).`,
      requestParams: { path: z.object({ slug: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StoreProduct' })), ...errors(404) },
    },
  },
  '/v1/store/cart': {
    post: {
      tags,
      summary: 'Check a cart',
      description:
        `${note} The cart lives in the browser; this returns today's prices, what is available (quantities are lowered to the stock), ` +
        'and with a district the delivery charge and how much more is needed for free delivery. Nothing is saved. ' +
        'Bulk discounts (Settings > Bulk discounts) are applied: each line has bulk { percent, discount, next } and lineTotal after it; subtotal is after them and bulkSavings is what they took off. ' +
        'Placing the order works them out again the same way. ' +
        'With couponCode: coupon { ok, message, itemsOff, deliveryOff, label, checkedAtOrder }. Per-person rules (once per customer, first orders, private codes) are checked for a signed-in shopper now, for others when the order is placed. Too many wrong codes from one connection: codes are not looked up for a while.',
      requestBody: jsonBody(cartBody),
      responses: { '200': json(open.meta({ id: 'StoreCart' })), ...errors(400) },
    },
  },
  '/v1/store/search-log': {
    post: {
      tags,
      summary: 'Record a search',
      description: "Sent by the shopper's browser after a search page shows, for the search report (searches with no results, corrected words). Nothing is returned.",
      requestBody: jsonBody(searchLogBody),
      responses: { '204': { description: 'Recorded' } },
    },
  },
  '/v1/store/product-requests': {
    post: {
      tags,
      summary: 'Request a product',
      description:
        'A shopper asks for something the shop does not have (from a search that found nothing). Staff see it in the admin. ' +
        'At most 5 per visitor per hour. "website" must stay empty (a hidden box that only bots fill).',
      requestBody: jsonBody(productRequestBody),
      responses: { '201': json(z.object({ ok: z.boolean() }), 'Sent'), ...errors(400, 429) },
    },
  },
  '/v1/store/supplier-leads': {
    post: {
      tags,
      summary: 'Sell with us (supplier lead)',
      description:
        'A brand, maker or wholesaler who wants to sell through the shop leaves their details. Staff see it in the admin (Requests & Leads → Sell with us) ' +
        'and get an email at the staff address (Integrations → Email). ways: wholesale (they supply us), brand (we list their products and order per sale), unsure. ' +
        'A link without https:// gets it added. At most 5 per visitor per hour (shared with product requests). "website" must stay empty (bots fill it).',
      requestBody: jsonBody(supplierLeadBody),
      responses: { '201': json(z.object({ ok: z.boolean() }), 'Sent'), ...errors(400, 429) },
    },
  },
  '/v1/store/orders': {
    post: {
      tags,
      summary: 'Place an order (checkout)',
      description:
        'Cash on delivery. Prices, stock and the delivery charge are worked out by the API, never taken from the browser. ' +
        'The customer is found by phone number (or added) and the address saved. Stock is taken at once. ' +
        '409 PRICE_CHANGED: the total is no longer expectedTotal (prices changed); check the cart and send again. ' +
        '400 with fields items.N.quantity: not enough stock (someone may have just bought the last ones). ' +
        'The same requestId again returns the order already placed (200), so retries never make two orders. ' +
        'At most 20 orders per connection per hour. Returns the order number and the token for GET /v1/store/orders/{token}. ' +
        'Then, in the background: a confirmation email to the customer (when they gave an email) and an alert to the shop (Integrations, Email, "New-order alerts to").',
      requestBody: jsonBody(checkoutBody),
      responses: {
        '201': json(z.object({ number: z.number(), token: z.string().nullable(), total: z.number() }).meta({ id: 'StoreOrderPlaced' }), 'Placed'),
        '200': json(z.object({ number: z.number(), token: z.string().nullable(), total: z.number() }), 'Already placed (same requestId)'),
        ...errors(400, 409, 429),
      },
    },
  },
  '/v1/store/track': {
    post: {
      tags,
      summary: 'Track an order',
      description:
        'The order number and the phone it was placed with. Answers where it is (status, dates, area), what is still to pay, and once it is with the courier the tracking code and link and every step of the journey (newest first). ' +
        'No address or items. A wrong number and a wrong phone give the same 404. 30 tries per 10 minutes.',
      requestBody: jsonBody(trackBody),
      responses: { '200': json(open.meta({ id: 'StoreTrackedOrder' })), ...errors(400, 404, 429) },
    },
  },
  '/v1/store/orders/{token}': {
    get: {
      tags,
      summary: 'An order, for its thank-you page',
      description:
        'The token from placing the order is the only key (no sign-in). Items, address, totals and status, and paying online: online.available, online.amount (a business’s advance, else what is due) and online.lastTry. A try still waiting for an answer is asked from SSLCommerz first (at most every 30 s).',
      requestParams: { path: z.object({ token: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StoreOrder' })), ...errors(404) },
    },
  },
  '/v1/store/orders/{token}/pay': {
    post: {
      tags,
      summary: 'Pay an order online now',
      description:
        'A new try with SSLCommerz: answers payUrl (its payment page). The amount is worked out by the shop. After paying, SSLCommerz sends the shopper back to /v1/webhooks/sslcommerz/return/{success|fail|cancel}, which checks the payment and goes on to the order’s thank-you page. 409 when nothing is left to pay.',
      requestParams: { path: z.object({ token: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StorePayStart' })), ...errors(400, 404, 409, 429) },
    },
  },
  '/v1/store/orders/{token}/cod': {
    post: {
      tags,
      summary: 'Pay cash on delivery instead of online',
      description: 'Only while nothing is paid online (409 otherwise).',
      requestParams: { path: z.object({ token: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StorePayCod' })), ...errors(404, 409, 429) },
    },
  },
  '/v1/store/cards': {
    get: {
      tags,
      summary: 'Product cards by id',
      description: `${note} ids: comma separated (up to 60). In that order; products no longer for sale are left out.`,
      requestParams: { query: z.object({ ids: z.string() }) },
      responses: { '200': json(open.meta({ id: 'StoreCardsById' })) },
    },
  },
  '/v1/store/me/wishlist/ids': {
    get: { tags, summary: 'Saved product ids (the hearts)', description: 'Signed in: their saved product ids, newest first. Signed out: an empty list.', responses: { '200': json(open.meta({ id: 'StoreWishlistIds' })) } },
  },
  '/v1/store/me/wishlist': {
    get: {
      tags,
      summary: 'The wishlist, with what changed',
      description: 'Signed in. Newest first: price and stock now, cheaper (taka off since saved), backInStock. Products no longer for sale are left out.',
      responses: { '200': json(open.meta({ id: 'StoreWishlist' })), ...errors(401) },
    },
  },
  '/v1/store/me/wishlist/{productId}': {
    put: {
      tags,
      summary: 'Save a product',
      description: 'Signed in. Saving again changes nothing. Up to 200 products (409 when full). The price and stock now are kept, for "cheaper" and "back in stock".',
      requestParams: { path: z.object({ productId: z.string() }) },
      responses: { '204': { description: 'Saved' }, ...errors(401, 404, 409, 429) },
    },
    delete: {
      tags,
      summary: 'Remove a product',
      requestParams: { path: z.object({ productId: z.string() }) },
      responses: { '204': { description: 'Removed' }, ...errors(401, 429) },
    },
  },
  '/v1/store/push/devices': {
    post: {
      tags,
      summary: 'This browser allowed alerts (push notifications)',
      description: 'Its Firebase Cloud Messaging token. A signed-in shopper’s device becomes theirs (order updates, saved items); any device can get the shop’s offers.',
      responses: { '204': { description: 'Saved' }, ...errors(400, 429) },
    },
  },
  '/v1/store/push/devices/remove': {
    post: { tags, summary: 'This browser turned alerts off', responses: { '204': { description: 'Removed' }, ...errors(400, 429) } },
  },
  '/v1/store/me/notifications': {
    get: { tags, summary: 'Which alerts they want', description: 'Signed in: orders, offers, wishlist (on/off) and how many devices have alerts on.', responses: { '200': json(open.meta({ id: 'StoreNotificationPrefs' })), ...errors(401) } },
    patch: { tags, summary: 'Change which alerts they want', description: 'Any of orders, offers, wishlist (true/false).', responses: { '200': json(open.meta({ id: 'StoreNotificationPrefsSaved' })), ...errors(400, 401) } },
  },
  '/v1/webhooks/sslcommerz/ipn': {
    post: {
      tags: ['Webhooks'],
      summary: 'SSLCommerz payment notification (IPN)',
      description:
        'Form post from SSLCommerz (tran_id, val_id, status…). Nothing in it is trusted: a payment counts only after the validation API confirms this try, in BDT, for exactly the amount asked, and only once. 404 for an unknown tran_id.',
      responses: { '200': { description: 'OK' }, ...errors(400, 404) },
    },
  },
};
