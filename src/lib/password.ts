import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (password: string) => hash(password);

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Used when the email does not exist, so a failed login takes the same time either way.
const DUMMY_HASH = await hashPassword('not-a-real-password');
export const fakeVerify = (password: string) => verifyPassword(DUMMY_HASH, password);
