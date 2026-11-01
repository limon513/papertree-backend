import { Router } from 'express';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, roles } from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { hashPassword } from '../../../lib/password.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { deleteAllSessions } from '../auth/session.ts';
import { createStaffBody, updateStaffBody } from './schemas.ts';

/** Staff = admin panel users. Mounted behind requireAdmin + requireSuperAdmin. */
export const staffRouter = Router();

const staffColumns = {
  id: adminUsers.id,
  name: adminUsers.name,
  email: adminUsers.email,
  status: adminUsers.status,
  lastLoginAt: adminUsers.lastLoginAt,
  createdAt: adminUsers.createdAt,
  updatedAt: adminUsers.updatedAt,
  role: { id: roles.id, name: roles.name, isSuperAdmin: roles.isSuperAdmin },
};

async function getStaff(id: number) {
  const [row] = await db
    .select(staffColumns)
    .from(adminUsers)
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .where(eq(adminUsers.id, id))
    .limit(1);
  if (!row) throw notFound('Staff member not found');
  return row;
}

async function getRole(roleId: number) {
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw badRequest('Choose a valid role', { roleId: 'Choose a valid role' });
  return role;
}

async function emailTaken(email: string, exceptId?: number) {
  const where = exceptId ? and(eq(adminUsers.email, email), ne(adminUsers.id, exceptId)) : eq(adminUsers.email, email);
  const [row] = await db.select({ id: adminUsers.id }).from(adminUsers).where(where).limit(1);
  return Boolean(row);
}

/** Active Super Admins other than this staff member. We never let this reach zero. */
async function otherActiveSuperAdmins(exceptId: number) {
  const [row] = await db
    .select({ n: count() })
    .from(adminUsers)
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .where(and(eq(roles.isSuperAdmin, true), eq(adminUsers.status, 'active'), ne(adminUsers.id, exceptId)));
  return row?.n ?? 0;
}

const LAST_SUPER_ADMIN = 'There must always be at least one active Super Admin';

staffRouter.get('/', async (_req, res) => {
  const items = await db
    .select(staffColumns)
    .from(adminUsers)
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .orderBy(asc(adminUsers.createdAt));
  res.json({ items });
});

staffRouter.get('/:id', async (req, res) => {
  res.json(await getStaff(parseId(req.params.id)));
});

staffRouter.post('/', async (req, res) => {
  const input = createStaffBody.parse(req.body);
  await getRole(input.roleId);
  if (await emailTaken(input.email)) throw conflict('This email is already used by another staff member');

  const [created] = await db
    .insert(adminUsers)
    .values({
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      roleId: input.roleId,
      status: input.status,
    })
    .returning({ id: adminUsers.id });

  const staff = await getStaff(created!.id);
  await audit(req, { action: 'staff.create', entityType: 'admin_user', entityId: staff.id, after: staff });
  res.status(201).json(staff);
});

staffRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const me = currentAdmin(req);
  const input = updateStaffBody.parse(req.body);
  const before = await getStaff(id);

  const isSelf = id === me.id;
  if (isSelf && input.status === 'disabled') throw badRequest('You cannot disable your own account');
  if (isSelf && input.roleId !== undefined && input.roleId !== before.role.id) {
    throw badRequest('You cannot change your own role');
  }

  const newRole = input.roleId !== undefined ? await getRole(input.roleId) : null;
  const losesSuperAdmin =
    before.role.isSuperAdmin &&
    before.status === 'active' &&
    ((newRole && !newRole.isSuperAdmin) || input.status === 'disabled');
  if (losesSuperAdmin && (await otherActiveSuperAdmins(id)) === 0) throw badRequest(LAST_SUPER_ADMIN);

  if (input.email && (await emailTaken(input.email, id))) {
    throw conflict('This email is already used by another staff member');
  }

  await db
    .update(adminUsers)
    .set({
      name: input.name,
      email: input.email,
      roleId: input.roleId,
      status: input.status,
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    })
    .where(eq(adminUsers.id, id));

  // A disabled account or a reset password signs the person out everywhere.
  if (input.status === 'disabled' || (input.password && !isSelf)) await deleteAllSessions(id);

  const after = await getStaff(id);
  await audit(req, {
    action: input.password ? 'staff.update_with_password' : 'staff.update',
    entityType: 'admin_user',
    entityId: id,
    before,
    after,
  });
  res.json(after);
});

staffRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === currentAdmin(req).id) throw badRequest('You cannot delete your own account');

  const before = await getStaff(id);
  if (before.role.isSuperAdmin && before.status === 'active' && (await otherActiveSuperAdmins(id)) === 0) {
    throw badRequest(LAST_SUPER_ADMIN);
  }

  await db.delete(adminUsers).where(eq(adminUsers.id, id));
  await audit(req, { action: 'staff.delete', entityType: 'admin_user', entityId: id, before });
  res.status(204).end();
});
