import { Router } from 'express';
import { requireAdmin, requireModule, requireSuperAdmin } from '../../middleware/admin-auth.ts';
import { authRouter } from './auth/routes.ts';
import { brandsRouter } from './brands/routes.ts';
import { categoriesRouter } from './categories/routes.ts';
import { importsRouter } from './imports/routes.ts';
import { iconsRouter, mediaRouter } from './media/routes.ts';
import { productsRouter, stockLocationsRouter } from './products/routes.ts';
import { rolesRouter } from './roles/routes.ts';
import { staffRouter } from './staff/routes.ts';

/** Everything under /v1/admin. */
export const adminRouter = Router();

adminRouter.use('/auth', authRouter);
adminRouter.use('/staff', requireAdmin, requireSuperAdmin, staffRouter);
adminRouter.use('/roles', requireAdmin, requireSuperAdmin, rolesRouter);
adminRouter.use('/categories', requireAdmin, requireModule('products'), categoriesRouter);
adminRouter.use('/brands', requireAdmin, requireModule('products'), brandsRouter);
adminRouter.use('/media', requireAdmin, mediaRouter);
adminRouter.use('/icons', requireAdmin, iconsRouter);
adminRouter.use('/products', requireAdmin, requireModule('products'), productsRouter);
adminRouter.use('/stock-locations', requireAdmin, requireModule('products'), stockLocationsRouter);
adminRouter.use('/imports', requireAdmin, requireModule('imports'), importsRouter);
