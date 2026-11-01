import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { ADMIN_COOKIE, findSession, setSessionCookie, type AdminContext } from '../modules/admin/auth/session.ts';
import type { AdminModule } from '../modules/admin/modules.ts';

/** Requires a signed-in, active admin. Sets req.admin. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[ADMIN_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized();

  const found = await findSession(token);
  if (!found) throw unauthorized('Your session has ended. Please sign in again.');

  setSessionCookie(res, token, found.expiresAt);
  req.admin = found.admin;
  next();
}

/** Use after requireAdmin. Super Admins can open every module. */
export function requireModule(module: AdminModule) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = currentAdmin(req).role;
    if (!role.isSuperAdmin && !role.modules.includes(module)) throw forbidden();
    next();
  };
}

/** Use after requireAdmin. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!currentAdmin(req).role.isSuperAdmin) throw forbidden('Only a Super Admin can do this');
  next();
}

export function currentAdmin(req: Request): AdminContext {
  if (!req.admin) throw unauthorized();
  return req.admin;
}
