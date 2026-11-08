import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';
import { AppError } from './errors.ts';

/**
 * Encrypts secrets (API keys, passwords) before they go into the database, with the server's
 * SECRETS_KEY (AES-256-GCM: a stolen database or backup reveals nothing, and tampering is detected).
 * Stored as "v1.<iv>.<tag>.<data>", base64url.
 */
const key = () => {
  if (!env.SECRETS_KEY) {
    throw new AppError(503, 'SECRETS_KEY_MISSING', 'The server has no SECRETS_KEY yet, so secrets cannot be saved. Ask the developer to set it.');
  }
  return Buffer.from(env.SECRETS_KEY, 'base64');
};

export const canKeepSecrets = () => !!env.SECRETS_KEY;

export function encryptSecrets(values: Record<string, string>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecrets(stored: string | null): Record<string, string> {
  if (!stored) return {};
  const [version, iv, tag, data] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secrets format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')) as Record<string, string>;
}

/** "re_…a3f9": enough to recognise a saved secret, never enough to use it. */
export const hint = (value: string) => (value.length <= 8 ? '••••' : `${value.slice(0, 3)}…${value.slice(-4)}`);
