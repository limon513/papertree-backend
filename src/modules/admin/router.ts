import { Router } from 'express';
import { requireAdmin, requireSuperAdmin } from '../../middleware/admin-auth.ts';
import { authRouter } from './auth/routes.ts';
import { rolesRouter } from './roles/routes.ts';
import { staffRouter } from './staff/routes.ts';

/** Everything under /v1/admin. */
export const adminRouter = Router();

adminRouter.use('/auth', authRouter);
adminRouter.use('/staff', requireAdmin, requireSuperAdmin, staffRouter);
adminRouter.use('/roles', requireAdmin, requireSuperAdmin, rolesRouter);
