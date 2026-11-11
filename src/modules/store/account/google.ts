import { createHmac, createPublicKey, timingSafeEqual, verify, type webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;
import { env } from '../../../config/env.ts';
import { badRequest } from '../../../lib/errors.ts';

/**
 * Google sign-in (through Firebase): the website gets an ID token from Google; we check it here with
 * Google's public keys, so no Firebase secret is needed. The token must be for this shop's Firebase
 * project and not expired.
 */
const KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let keys: { at: number; maxAge: number; list: (JsonWebKey & { kid: string })[] } | null = null;

async function publicKey(kid: string) {
  if (!keys || Date.now() - keys.at > keys.maxAge || !keys.list.some((k) => k.kid === kid)) {
    const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google keys: ${res.status}`);
    const maxAge = Number(res.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 3600) * 1000;
    keys = { at: Date.now(), maxAge, list: ((await res.json()) as { keys: (JsonWebKey & { kid: string })[] }).keys };
  }
  const jwk = keys.list.find((k) => k.kid === kid);
  return jwk ? createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

export interface GoogleUser {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

const invalid = () => badRequest('Google sign-in did not work. Please try again.');
const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

export async function verifyGoogleToken(idToken: string, projectId: string): Promise<GoogleUser> {
  const [head, body, signature] = idToken.split('.');
  if (!head || !body || !signature) throw invalid();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = part(head);
    claims = part(body);
  } catch {
    throw invalid();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();
  const key = await publicKey(header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) throw invalid();
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.exp !== 'number' ||
    claims.exp < now ||
    (typeof claims.iat === 'number' && claims.iat > now + 300)
  ) {
    throw invalid();
  }
  return {
    uid: claims.sub,
    // Only an address Google confirmed.
    email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' && /^https:\/\//.test(claims.picture) ? claims.picture : null,
  };
}

/**
 * A first Google sign-in still needs a phone number. Until it is confirmed with a code, the Google
 * details travel as this short-lived signed ticket (signed with SECRETS_KEY, so it cannot be faked).
 */
const sign = (data: string) => createHmac('sha256', Buffer.from(env.SECRETS_KEY ?? '', 'base64')).update(`google-ticket:${data}`).digest('base64url');

export function googleTicket(user: GoogleUser) {
  if (!env.SECRETS_KEY) throw badRequest('Google sign-in is not ready on this server yet.');
  const data = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function readGoogleTicket(ticket: string): GoogleUser {
  const [data, mac] = ticket.split('.');
  if (!data || !mac || !env.SECRETS_KEY) throw badRequest('Please sign in with Google again.');
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw badRequest('Please sign in with Google again.');
  const user = part(data) as unknown as GoogleUser & { exp: number };
  if (user.exp < Date.now()) throw badRequest('That took a while: please sign in with Google again.');
  return { uid: user.uid, email: user.email, name: user.name, picture: user.picture };
}
