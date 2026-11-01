import { createHash, randomBytes } from 'node:crypto';

/** A random token that is safe to put in a cookie or URL. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** We store only the hash of session tokens, never the token itself. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
