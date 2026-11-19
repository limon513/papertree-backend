import { createSign } from 'node:crypto';
import { env } from '../../config/env.ts';
import { getIntegration, stateOf } from '../admin/integrations/service.ts';

/**
 * Firebase Cloud Messaging (HTTP v1), without the Firebase Admin library: the shop's service account
 * signs a short token request (RS256) for an access token, which sends each message. Free.
 */
export const REAL_FCM = 'https://fcm.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushSetup {
  account: ServiceAccount;
  /** Away from the live server or in test mode: only these customers' devices get real alerts. */
  testOnly: boolean;
  testPhones: string[];
  /** The real Firebase (not a test stand-in). */
  real: boolean;
}

/** The shop's push setup, or null when push is off or not set up. */
export async function pushSetup(): Promise<PushSetup | null> {
  const s = await getIntegration('push');
  const state = stateOf('push', s);
  if (state === 'off' || state === 'incomplete') return null;
  let account: ServiceAccount;
  try {
    account = JSON.parse(s.secrets.serviceAccount!) as ServiceAccount;
  } catch {
    return null;
  }
  if (!account.project_id || !account.client_email || !account.private_key) return null;
  return { account, testOnly: state === 'test', testPhones: s.settings.testPhones, real: env.FCM_URL.replace(/\/$/, '') === REAL_FCM };
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

let access: { key: string; value: string; until: number } | null = null;

/** An access token for sending (kept until a minute before it runs out). */
async function accessToken(a: ServiceAccount, fresh = false) {
  if (!fresh && access && access.key === a.client_email && access.until > Date.now() + 60_000) return access.value;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = a.token_uri ?? 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(a.private_key).toString('base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !data?.access_token) throw new Error(`Firebase sign-in failed (${res.status})`);
  access = { key: a.client_email, value: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return access.value;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where a tap opens (an address on the website). */
  url: string;
  /** Messages with the same tag replace each other on the device (one per order, not a pile). */
  tag?: string;
  image?: string | null;
  /** For counting taps (offers). */
  id?: string;
}

export type SendOutcome = { result: 'sent' } | { result: 'gone' } | { result: 'failed'; error: string };

/** Sends one message to one device. "gone": the device no longer takes messages (drop it). */
export async function sendOne(setup: PushSetup, token: string, msg: PushMessage, opts: { ttlSeconds: number; urgent?: boolean }): Promise<SendOutcome> {
  const site = env.STOREFRONT_URL.replace(/\/$/, '');
  const link = msg.url.startsWith('http') ? msg.url : `${site}${msg.url}`;
  // Data only: the website's own service worker shows it, the same on every browser.
  const data: Record<string, string> = { title: msg.title, body: msg.body, url: link, tag: msg.tag ?? '', image: msg.image ?? '', id: msg.id ?? '' };
  const body = JSON.stringify({
    message: { token, data, webpush: { headers: { TTL: String(opts.ttlSeconds), Urgency: opts.urgent ? 'high' : 'normal' }, fcm_options: { link } } },
  });
  const url = `${env.FCM_URL.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(setup.account.project_id)}/messages:send`;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(setup.account, attempt > 1)}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      return { result: 'failed', error: err instanceof Error ? err.message.slice(0, 200) : 'No answer' };
    }
    if (res.ok) return { result: 'sent' };
    const err = (await res.json().catch(() => null)) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null;
    const code = err?.error?.details?.find((d) => d.errorCode)?.errorCode ?? err?.error?.status ?? '';
    // The token is no longer valid (app removed, permission taken back, browser data cleared).
    if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && /token/i.test(err?.error?.message ?? '') && code === 'INVALID_ARGUMENT')) return { result: 'gone' };
    // The access token ran out early: once more with a new one.
    if (res.status === 401 && attempt === 1) continue;
    return { result: 'failed', error: `${res.status} ${code} ${err?.error?.message ?? ''}`.trim().slice(0, 200) };
  }
}
