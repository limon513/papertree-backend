import { eq } from 'drizzle-orm';
import { db, pool } from './client.ts';
import { adminUsers, roles } from './schema/index.ts';
import { hashPassword } from '../lib/password.ts';

const SUPER_ADMIN_ROLE = 'Super Admin';

let [superRole] = await db.select().from(roles).where(eq(roles.isSuperAdmin, true)).limit(1);

if (!superRole) {
  [superRole] = await db
    .insert(roles)
    .values({
      name: SUPER_ADMIN_ROLE,
      description: 'Full access to everything',
      isSuperAdmin: true,
      canImpersonate: true,
    })
    .returning();
  console.log('Created role: Super Admin');
}

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
const name = process.env.SEED_ADMIN_NAME?.trim() || 'Super Admin';

if (email && password && superRole) {
  const [existing] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  if (existing) {
    console.log(`Admin ${email} already exists, skipped.`);
  } else {
    await db.insert(adminUsers).values({
      name,
      email,
      passwordHash: await hashPassword(password),
      roleId: superRole.id,
    });
    console.log(`Created Super Admin: ${email}`);
  }
} else {
  console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set, no admin user created.');
}

await pool.end();
