import { Router } from 'express';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, roles } from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { createRoleBody, updateRoleBody } from './schemas.ts';

/** Mounted behind requireAdmin + requireSuperAdmin. */
export const rolesRouter = Router();

async function getRole(id: number) {
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) throw notFound('Role not found');
  return role;
}

async function nameTaken(name: string, exceptId?: number) {
  const where = exceptId ? and(eq(roles.name, name), ne(roles.id, exceptId)) : eq(roles.name, name);
  const [row] = await db.select({ id: roles.id }).from(roles).where(where).limit(1);
  return Boolean(row);
}

const NAME_TAKEN = 'A role with this name already exists';

rolesRouter.get('/', async (_req, res) => {
  const staffCounts = db
    .select({ roleId: adminUsers.roleId, staffCount: count().as('staff_count') })
    .from(adminUsers)
    .groupBy(adminUsers.roleId)
    .as('staff_counts');

  const rows = await db
    .select({ role: roles, staffCount: staffCounts.staffCount })
    .from(roles)
    .leftJoin(staffCounts, eq(staffCounts.roleId, roles.id))
    .orderBy(asc(roles.createdAt));

  res.json({ items: rows.map((r) => ({ ...r.role, staffCount: r.staffCount ?? 0 })) });
});

rolesRouter.get('/:id', async (req, res) => {
  res.json(await getRole(parseId(req.params.id)));
});

rolesRouter.post('/', async (req, res) => {
  const input = createRoleBody.parse(req.body);
  if (await nameTaken(input.name)) throw conflict(NAME_TAKEN);

  const [role] = await db
    .insert(roles)
    .values({
      name: input.name,
      description: input.description ?? null,
      modules: input.modules,
      canImpersonate: input.canImpersonate,
    })
    .returning();

  await audit(req, { action: 'role.create', entityType: 'role', entityId: role!.id, after: role });
  res.status(201).json(role);
});

rolesRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = updateRoleBody.parse(req.body);
  const before = await getRole(id);

  // The Super Admin role always has full access. Only its name and description can change.
  if (before.isSuperAdmin && (input.modules !== undefined || input.canImpersonate !== undefined)) {
    throw badRequest('The Super Admin role always has full access and cannot be limited');
  }
  if (input.name && (await nameTaken(input.name, id))) throw conflict(NAME_TAKEN);

  const [after] = await db
    .update(roles)
    .set({
      name: input.name,
      description: input.description,
      modules: input.modules,
      canImpersonate: input.canImpersonate,
    })
    .where(eq(roles.id, id))
    .returning();

  await audit(req, { action: 'role.update', entityType: 'role', entityId: id, before, after });
  res.json(after);
});

rolesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getRole(id);
  if (before.isSuperAdmin) throw badRequest('The Super Admin role cannot be deleted');

  const [used] = await db.select({ n: count() }).from(adminUsers).where(eq(adminUsers.roleId, id));
  if (used && used.n > 0) {
    throw badRequest(`${used.n} staff member(s) still have this role. Move them to another role first.`);
  }

  await db.delete(roles).where(eq(roles.id, id));
  await audit(req, { action: 'role.delete', entityType: 'role', entityId: id, before });
  res.status(204).end();
});
