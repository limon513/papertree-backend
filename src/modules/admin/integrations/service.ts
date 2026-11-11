import { eq } from 'drizzle-orm';
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
      return s.secrets.apiKey && set.fromEmail ? 'ready' : 'incomplete';
    case 'sms':
      if (set.provider === 'log') return 'test';
      return 'incomplete'; // BulkSMSBD is connected in a later step.
    case 'google':
      if (!set.enabled) return 'off';
      return set.apiKey && set.authDomain && set.projectId && set.appId ? 'ready' : 'incomplete';
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
/**
 * `logText`: what the log keeps once SMS really goes out (e.g. a sign-in code hidden). In test mode the
 * full text is kept, as the log is then the only place to read it.
 */
export async function sendSms(message: { to: string; text: string; logText?: string; purpose: Purpose }) {
  const { settings } = await getIntegration('sms');
  const [row] = await db
    .insert(messageLog)
    .values({
      channel: 'sms',
      to: message.to,
      body: message.text,
      // BulkSMSBD is connected in a later step: until then every SMS stays in the log.
      status: 'logged',
      provider: settings.provider,
      error: settings.provider === 'log' ? null : 'BulkSMSBD is not connected yet: kept in the log',
      purpose: message.purpose,
    })
    .returning();
  return row!;
}
