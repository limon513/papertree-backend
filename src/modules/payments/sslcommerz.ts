import { env, isProduction } from '../../config/env.ts';
import { badRequest } from '../../lib/errors.ts';
import { getIntegration, stateOf } from '../admin/integrations/service.ts';

/**
 * SSLCommerz (bKash, Nagad, Rocket, cards, internet banking), API v4:
 * - start a session (the shopper is sent to its payment page),
 * - validate a payment by its val_id (the only proof we trust),
 * - look a try up by our tran_id (when the IPN and the return both went missing).
 * The store password goes in the request to SSLCommerz only: never logged, never stored in a row.
 */
const LIVE = 'https://securepay.sslcommerz.com';
const TIMEOUT_MS = 20_000;

export interface Gateway {
  sandbox: boolean;
  host: string;
  storeId: string;
  storePassword: string;
}

/** The shop's SSLCommerz account, or null when online payment is off or not set up. */
export async function gateway(): Promise<Gateway | null> {
  const s = await getIntegration('payment');
  if (stateOf('payment', s) !== 'ready') return null;
  const sandbox = s.settings.sandbox;
  // Away from the live server, never real money (tests, a developer's computer), unless asked for.
  if (!sandbox && !isProduction && !env.SSLCOMMERZ_ALLOW_LIVE) return null;
  return { sandbox, host: sandbox ? env.SSLCOMMERZ_SANDBOX_URL.replace(/\/$/, '') : LIVE, storeId: s.settings.storeId!, storePassword: s.secrets.storePassword! };
}

/** Is paying online offered at checkout? */
export const onlinePaymentReady = async () => (await gateway()) !== null;

async function request(url: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw badRequest('The payment service did not answer. Please try again in a moment.');
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) throw badRequest('The payment service did not answer properly. Please try again in a moment.');
  return data;
}

const cut = (v: string | null | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export interface SessionInput {
  tranId: string;
  amount: number;
  orderNumber: number;
  customer: { name: string; phone: string; email: string | null; address: string; city: string };
  productNames: string[];
  items: number;
  urls: { success: string; fail: string; cancel: string; ipn: string };
}

/** Starts a payment: the payment page's address, or SSLCommerz's reason for saying no. */
export async function startSession(g: Gateway, input: SessionInput) {
  const form = new URLSearchParams({
    store_id: g.storeId,
    store_passwd: g.storePassword,
    total_amount: input.amount.toFixed(2),
    currency: 'BDT',
    tran_id: input.tranId,
    success_url: input.urls.success,
    fail_url: input.urls.fail,
    cancel_url: input.urls.cancel,
    ipn_url: input.urls.ipn,
    cus_name: cut(input.customer.name, 50),
    // SSLCommerz requires an email; many shoppers here give none.
    cus_email: cut(input.customer.email, 50) || 'no-email@papertree.com.bd',
    cus_add1: cut(input.customer.address, 50),
    cus_city: cut(input.customer.city, 50),
    cus_postcode: '0000',
    cus_country: 'Bangladesh',
    cus_phone: cut(input.customer.phone, 20),
    shipping_method: 'Courier',
    num_of_item: String(Math.max(1, input.items)),
    ship_name: cut(input.customer.name, 50),
    ship_add1: cut(input.customer.address, 50),
    ship_city: cut(input.customer.city, 50),
    ship_postcode: '0000',
    ship_country: 'Bangladesh',
    product_name: cut(input.productNames.join(', '), 255) || `Order #${input.orderNumber}`,
    product_category: 'Stationery',
    product_profile: 'physical-goods',
    value_a: String(input.orderNumber),
  });
  const data = await request(`${g.host}/gwprocess/v4/api.php`, { method: 'POST', body: form });
  const url = typeof data.GatewayPageURL === 'string' ? data.GatewayPageURL : '';
  // The payment page is always https (only the test stand-in for the sandbox may be on this computer).
  const safe = /^https:\/\//.test(url) || (g.sandbox && g.host.startsWith('http://localhost') && url.startsWith(g.host));
  if (data.status === 'SUCCESS' && safe) {
    return { ok: true as const, url, sessionKey: typeof data.sessionkey === 'string' ? data.sessionkey : null };
  }
  return { ok: false as const, reason: typeof data.failedreason === 'string' ? data.failedreason.slice(0, 300) : 'SSLCommerz did not start the payment' };
}

/** What SSLCommerz says about a payment (validation API). Only the parts we use or keep. */
export interface Validation {
  status: string;
  tranId: string;
  valId: string;
  amount: number;
  currency: string;
  bankTranId: string | null;
  cardType: string | null;
  riskLevel: string | null;
  riskTitle: string | null;
  tranDate: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Asks SSLCommerz whether this val_id is a real, successful payment. */
export async function validate(g: Gateway, valId: string): Promise<Validation> {
  const q = new URLSearchParams({ val_id: valId, store_id: g.storeId, store_passwd: g.storePassword, format: 'json' });
  const d = await request(`${g.host}/validator/api/validationserverAPI.php?${q}`);
  return {
    status: str(d.status) ?? 'UNKNOWN',
    tranId: str(d.tran_id) ?? '',
    valId: str(d.val_id) ?? valId,
    amount: Number(d.amount),
    currency: str(d.currency) ?? '',
    bankTranId: str(d.bank_tran_id),
    cardType: str(d.card_type),
    riskLevel: str(d.risk_level),
    riskTitle: str(d.risk_title),
    tranDate: str(d.tran_date),
  };
}

/** Our try as SSLCommerz knows it: its tries' statuses and val_ids (newest answer SSLCommerz gives). */
export async function lookUp(g: Gateway, tranId: string) {
  const q = new URLSearchParams({ tran_id: tranId, store_id: g.storeId, store_passwd: g.storePassword, format: 'json' });
  const d = await request(`${g.host}/validator/api/merchantTransIDvalidationAPI.php?${q}`);
  const list = Array.isArray(d.element) ? (d.element as Record<string, unknown>[]) : [];
  return { connected: d.APIConnect === 'DONE', tries: list.map((e) => ({ status: str(e.status) ?? '', valId: str(e.val_id), error: str(e.error) })) };
}
