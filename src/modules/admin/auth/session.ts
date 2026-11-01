import type { Request, Response } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminSessions, adminUsers, roles } from '../../../db/schema/index.ts';
import { randomToken, sha256 } from '../../../lib/crypto.ts';
import { isProduction } from '../../../config/env.ts';

export const ADMIN_COOKIE = 'pt_admin';

const DAY = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME = 7 * DAY;
const RENEW_WHEN_LESS_THAN = 3.5 * DAY;
const TOUCH_EVERY = 5 * 60 * 1000;

export interface AdminContext {
  id: number;
  name: string;
  email: string;
  sessionId: string;
  role: {
    id: number;
    name: string;
    modules: string[];
    canImpersonate: boolean;
    isSuperAdmin: boolean;
  };
}

export async function createSession(adminUserId: number, req: Request) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME);
  await db.insert(adminSessions).values({
    id: sha256(token),
    adminUserId,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Finds the signed-in admin for a cookie token. Renews the session while it is in use. */
export async function findSession(token: string): Promise<{ admin: AdminContext; expiresAt: Date } | null> {
  const sessionId = sha256(token);
  const now = new Date();

  const [row] = await db
    .select({ session: adminSessions, user: adminUsers, role: roles })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .where(and(eq(adminSessions.id, sessionId), gt(adminSessions.expiresAt, now)))
    .limit(1);

  if (!row || row.user.status !== 'active') return null;

  let expiresAt = row.session.expiresAt;
  const needsRenew = expiresAt.getTime() - now.getTime() < RENEW_WHEN_LESS_THAN;
  const needsTouch = now.getTime() - row.session.lastUsedAt.getTime() > TOUCH_EVERY;
  if (needsRenew || needsTouch) {
    if (needsRenew) expiresAt = new Date(now.getTime() + SESSION_LIFETIME);
    await db
      .update(adminSessions)
      .set({ lastUsedAt: now, expiresAt })
      .where(eq(adminSessions.id, sessionId));
  }

  return {
    expiresAt,
    admin: {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      sessionId,
      role: {
        id: row.role.id,
        name: row.role.name,
        modules: row.role.modules,
        canImpersonate: row.role.canImpersonate,
        isSuperAdmin: row.role.isSuperAdmin,
      },
    },
  };
}

export const deleteSession = (sessionId: string) =>
  db.delete(adminSessions).where(eq(adminSessions.id, sessionId));

/** Signs a staff member out everywhere (used when disabled or the password changes). */
export const deleteAllSessions = (adminUserId: number) =>
  db.delete(adminSessions).where(eq(adminSessions.adminUserId, adminUserId));

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(ADMIN_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}
