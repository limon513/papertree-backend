import { eq } from 'drizzle-orm';
import { isProduction } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { adminUsers, integrations, INTEGRATION_KEYS, messageLog } from '../../../db/schema/index.ts';
import { logger } from '../../../lib/logger.ts';
import { decryptSecrets, encryptSecrets, hint } from '../../../lib/secrets.ts';
import { INTEGRATIONS, type IntegrationKey, type IntegrationSettings } from './schemas.ts';

// ---- Reading (cached a minute; saving clears it) ----

interface Loaded<K extends IntegrationKey> {
  settings: IntegrationSettings<K>;
  secrets: Record<string, string>;
  updatedAt: Date | null;
  updatedBy: number | null;
}
const cache = new Map<IntegrationKey, { at: number; value: Promise<Loaded<IntegrationKey>> }>();

async function load<K extends IntegrationKey>(key: K): Promise<Loaded<K>> {
  const [row] = await db.select().from(integrations).where(eq(integrations.key, key));
  let secrets: Record<string, string> = {};
  try {
    secrets = decryptSecrets(row?.secrets ?? null);
  } catch (err) {
    // A different SECRETS_KEY than when saved: the secrets cannot be read (they must be entered again).
    logger.error({ err, key }, 'Could not read saved secrets (wrong SECRETS_KEY?)');
  }
  return {
    settings: INTEGRATIONS[key].settings.parse(row?.settings ?? {}) as IntegrationSettings<K>,
    secrets,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export function getIntegration<K extends IntegrationKey>(key: K): Promise<Loaded<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value as Promise<Loaded<K>>;
  const value = load(key);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Will it be used? ready, test (SMS test mode), off, or incomplete (switched on but something missing). */
export function stateOf(key: IntegrationKey, s: Loaded<IntegrationKey>) {
  const set = s.settings as Record<string, unknown>;
  switch (key) {
    case 'email':
      if (set.provider === 'off') return 'off';
      if (!(s.secrets.apiKey && set.fromEmail)) return 'incomplete';
      return set.testMode || !isProduction ? 'test' : 'ready';
    case 'sms':
      if (set.provider === 'log') return 'test';
      if (!(s.secrets.apiKey && set.userName && set.senderId)) return 'incomplete';
      return set.testMode || !isProduction ? 'test' : 'ready';
    case 'google':
      if (!set.enabled) return 'off';
      return set.apiKey && set.authDomain && set.projectId && set.appId ? 'ready' : 'incomplete';
    case 'steadfast':
      if (!set.enabled) return 'off';
      return s.secrets.apiKey && s.secrets.secretKey ? 'ready' : 'incomplete';
    case 'payment':
      if (!set.enabled) return 'off';
      return set.storeId && s.secrets.storePassword ? 'ready' : 'incomplete';
  }
}

export async function integrationView(key: IntegrationKey) {
  const s = await getIntegration(key);
  const [by] = s.updatedBy ? await db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, s.updatedBy)) : [];
  return {
    key,
    settings: s.settings,
    secrets: Object.fromEntries(INTEGRATIONS[key].secrets.map((name) => [name, s.secrets[name] ? hint(s.secrets[name]) : null])),
    state: stateOf(key, s),
    updatedAt: s.updatedAt,
    updatedBy: by?.name ?? null,
  };
}

export const allIntegrationViews = () => Promise.all(INTEGRATION_KEYS.map((k) => integrationView(k)));

/**
 * Saves a service's settings. Secrets: a value replaces the saved one, null removes it, a missing
 * field keeps it. Returns the names of what changed (for the audit log: never the values).
 */
export async function saveIntegration(key: IntegrationKey, rawSettings: unknown, newSecrets: Record<string, string | null>, adminUserId: number) {
  const settings = INTEGRATIONS[key].settings.parse(rawSettings);
  const before = await load(key);
  const allowed: readonly string[] = INTEGRATIONS[key].secrets;
  const secrets = { ...before.secrets };
  const changed: string[] = Object.keys(settings).filter((k) => JSON.stringify((settings as Record<string, unknown>)[k]) !== JSON.stringify((before.settings as Record<string, unknown>)[k]));
  for (const [name, value] of Object.entries(newSecrets)) {
    if (!allowed.includes(name)) continue;
    if (value === null || value === '') delete secrets[name];
    else secrets[name] = value;
    changed.push(name);
  }
  const stored = Object.keys(secrets).length ? encryptSecrets(secrets) : null;
  await db
    .insert(integrations)
    .values({ key, settings, secrets: stored, updatedBy: adminUserId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: integrations.key, set: { settings, secrets: stored, updatedBy: adminUserId, updatedAt: new Date() } });
  cache.delete(key);
  return changed;
}

// ---- Sending ----

/**
 * Real messages cost money: in test mode, and always away from the live server, they go only to the
 * test numbers / addresses. Everything else is written to the message log, nothing sent.
 */
function reallySend(testMode: boolean, allowed: string[], to: string) {
  if (testMode || !isProduction) return allowed.includes(to);
  return true;
}

type Purpose = 'test' | 'order.placed' | 'order.alert' | 'login.code' | (string & {});

/** Sends an email with the shop's email service, and writes it to the message log. Never throws. */
export async function sendEmail(message: { to: string; subject: string; html: string; text: string; purpose: Purpose }) {
  const { settings, secrets } = await getIntegration('email');
  const record = (status: 'sent' | 'failed' | 'logged', error: string | null = null) =>
    db
      .insert(messageLog)
      .values({ channel: 'email', to: message.to, subject: message.subject, body: message.text, status, provider: settings.provider, error, purpose: message.purpose })
      .returning();
  if (settings.provider === 'off') return (await record('logged', 'Email is switched off'))[0]!;
  if (!secrets.apiKey || !settings.fromEmail) return (await record('failed', 'Email is not set up: add the Resend API key and the From address'))[0]!;
  if (!reallySend(settings.testMode, settings.testRecipients, message.to.toLowerCase())) {
    return (await record('logged', isProduction ? 'Test mode: sent only to the test addresses' : 'Not the live server: sent only to the test addresses'))[0]!;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${secrets.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: settings.fromName ? `${settings.fromName} <${settings.fromEmail}>` : settings.fromEmail,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(settings.replyTo && { reply_to: settings.replyTo }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return (await record('sent'))[0]!;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return (await record('failed', `Resend said: ${body?.message ?? res.statusText} (${res.status})`))[0]!;
  } catch (err) {
    return (await record('failed', `Could not reach Resend: ${(err as Error).message}`))[0]!;
  }
}

/** Sends an SMS with the shop's SMS service (test mode: only written to the log). Never throws. */
const MIMSMS = 'https://api.mimsms.com/api/V2';

/** "01712345678" -> "8801712345678" (MiMSMS wants the country code). */
const intl = (phone: string) => `88${phone}`;

/**
 * Sends an SMS with the shop's SMS service, and writes it to the log. Never throws.
 * `logText`: what the log keeps when it really goes out (a sign-in code is hidden); otherwise the full
 * text is kept, as the log is then the only place to read it.
 */
export async function sendSms(message: { to: string; text: string; logText?: string; purpose: Purpose }) {
  const { settings, secrets } = await getIntegration('sms');
  const record = async (status: 'sent' | 'failed' | 'logged', error: string | null, providerRef: string | null = null) => {
    const [row] = await db
      .insert(messageLog)
      .values({ channel: 'sms', to: message.to, body: status === 'sent' ? (message.logText ?? message.text) : message.text, status, provider: settings.provider, error, purpose: message.purpose, providerRef })
      .returning();
    return row!;
  };
  if (settings.provider === 'log') return record('logged', 'Test mode: SMS are only written to the log');
  if (!secrets.apiKey || !settings.userName || !settings.senderId) return record('failed', 'MiMSMS is not set up: add the account email, Sender ID and API key');
  if (!reallySend(settings.testMode, settings.testNumbers, message.to)) {
    return record('logged', isProduction ? 'Test mode: sent only to the test numbers' : 'Not the live server: sent only to the test numbers');
  }
  try {
    const res = await fetch(`${MIMSMS}/SMS`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: secrets.apiKey,
        userName: settings.userName,
        senderName: settings.senderId,
        transactionType: 'T',
        mobileNumber: intl(message.to),
        message: message.text,
        campaignName: message.purpose,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as {
      statusCode?: string;
      status?: string;
      responseResult?: string;
      trxnId?: string;
      success_Data?: { trackingId?: string }[] | null;
      error_Data?: { error?: string }[];
    } | null;
    if (res.ok && body?.statusCode === '200') return record('sent', null, body.success_Data?.[0]?.trackingId ?? body.trxnId ?? null);
    const reason = body?.error_Data?.[0]?.error ?? body?.responseResult ?? res.statusText;
    return record('failed', `MiMSMS said: ${reason} (${body?.statusCode ?? res.status})`);
  } catch (err) {
    return record('failed', `Could not reach MiMSMS: ${(err as Error).message}`);
  }
}

/** SMS left on the MiMSMS account. Free (nothing is sent): also a check that the key and IP allow-list work. */
export async function smsBalance() {
  const { settings, secrets } = await getIntegration('sms');
  if (settings.provider !== 'mimsms' || !secrets.apiKey || !settings.userName) return { ok: false as const, message: 'Choose MiMSMS and save the account email and API key first.' };
  try {
    const res = await fetch(`${MIMSMS}/BalanceCheck`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: secrets.apiKey, userName: settings.userName }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { statusCode?: string; status?: string; responseResult?: string } | null;
    if (res.ok && body?.statusCode === '200') return { ok: true as const, balance: body.responseResult ?? '0' };
    return { ok: false as const, message: `MiMSMS said: ${body?.responseResult ?? res.statusText} (${body?.statusCode ?? res.status}). Check the API key is active and this server's IP is allowed (sms.mimsms.com → Utility → Developer).` };
  } catch (err) {
    return { ok: false as const, message: `Could not reach MiMSMS: ${(err as Error).message}` };
  }
}
