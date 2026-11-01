import type { AdminContext } from '../modules/admin/auth/session.ts';

declare global {
  namespace Express {
    interface Request {
      admin?: AdminContext;
    }
  }
}

export {};
