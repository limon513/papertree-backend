import { Router } from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { rateLimit } from 'express-rate-limit';
import { db } from '../../../db/client.ts';
import { adminSessions, adminUsers } from '../../../db/schema/index.ts';
import { AppError, badRequest } from '../../../lib/errors.ts';
import { fakeVerify, hashPassword, verifyPassword } from '../../../lib/password.ts';
import { sha256 } from '../../../lib/crypto.ts';
import { audit } from '../../../lib/audit.ts';
import { currentAdmin, requireAdmin } from '../../../middleware/admin-auth.ts';
import { ADMIN_MODULES } from '../modules.ts';
import { changePasswordBody, loginBody } from './schemas.ts';
import {
  ADMIN_COOKIE,
  clearSessionCookie,
  createSession,
  deleteSession,
  findSession,
  setSessionCookie,
  type AdminContext,
} from './session.ts';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many sign-in attempts. Try again in 15 minutes.' } },
});

/** What the admin panel gets to know about the signed-in staff member. */
function toPublic(admin: AdminContext) {
  const { sessionId: _sessionId, ...rest } = admin;
  return rest;
}

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = loginBody.parse(req.body);

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  const passwordOk = user ? await verifyPassword(user.passwordHash, password) : (await fakeVerify(password), false);

  if (!user || !passwordOk) throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong email or password');
  if (user.status !== 'active') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Please contact a Super Admin.');
  }

  const { token, expiresAt } = await createSession(user.id, req);
  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));
  setSessionCookie(res, token, expiresAt);
  await audit(req, { action: 'auth.login', adminUserId: user.id, entityType: 'admin_user', entityId: user.id });

  const session = await findSession(token);
  if (!session) throw new AppError(500, 'SESSION_FAILED', 'Could not start the session');
  res.json({ admin: toPublic(session.admin), modules: ADMIN_MODULES });
});

authRouter.post('/logout', async (req, res) => {
  const token: unknown = req.cookies?.[ADMIN_COOKIE];
  if (typeof token === 'string' && token) await deleteSession(sha256(token));
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAdmin, (req, res) => {
  res.json({ admin: toPublic(currentAdmin(req)), modules: ADMIN_MODULES });
});

authRouter.post('/change-password', requireAdmin, async (req, res) => {
  const admin = currentAdmin(req);
  const { currentPassword, newPassword } = changePasswordBody.parse(req.body);

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id)).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw badRequest('Current password is wrong', { currentPassword: 'Current password is wrong' });
  }

  await db.update(adminUsers).set({ passwordHash: await hashPassword(newPassword) }).where(eq(adminUsers.id, admin.id));
  // Keep this browser signed in, sign out everywhere else.
  await db
    .delete(adminSessions)
    .where(and(eq(adminSessions.adminUserId, admin.id), ne(adminSessions.id, admin.sessionId)));
  await audit(req, { action: 'auth.change_password', entityType: 'admin_user', entityId: admin.id });

  res.status(204).end();
});
