import type { Request } from 'express';
import { db } from '../db/client.ts';
import { auditLogs } from '../db/schema/index.ts';
import { logger } from './logger.ts';

interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  adminUserId?: number;
}

/** Records an admin action. Never throws: a failed audit write must not break the request. */
export async function audit(req: Request, entry: AuditEntry) {
  try {
    await db.insert(auditLogs).values({
      adminUserId: entry.adminUserId ?? req.admin?.id ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId === undefined ? null : String(entry.entityId),
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: req.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, entry }, 'Failed to write audit log');
  }
}
