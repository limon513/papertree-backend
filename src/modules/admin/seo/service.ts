import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { notFoundLog, redirects, type RedirectSource } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import { cleanPath, cleanTarget, targetPathOf } from '../../../lib/paths.ts';
import type { Tx } from '../products/service.ts';

export const REDIRECT_CODES = [301, 302, 410] as const;
export type RedirectCode = (typeof REDIRECT_CODES)[number];

/** This shop's website: a full address there is fine as a target; any other site is not. */
function ownHosts() {
  const hosts = ['papertree.com.bd'];
  try {
    hosts.push(new URL(env.STOREFRONT_URL).hostname.toLowerCase().replace(/^www\./, ''));
  } catch {
    // Not a full address: the shop's domain only.
  }
  return hosts;
}

/** Addresses the website itself needs: they can never be redirected. */
const PROTECTED = [/^\/$/, /^\/(404|500)\/$/, /^\/(cart|checkout|account|search|api|_astro|icons|uploads)\//, /^\/sitemap[^/]*\.xml$/, /^\/robots\.txt$/];
export const isProtected = (path: string) => PROTECTED.some((r) => r.test(path));

/**
 * Adds or changes a redirect, keeping the list clean:
 * - no chains: A→B when B→C exists becomes A→C, and anything that pointed at A now points at B;
 * - no loops (A→…→A) and nothing to itself;
 * - the website's own pages (home, cart, checkout...) are never redirected.
 */
export async function saveRedirect(
  tx: Tx | typeof db,
  input: { from: string; to: string; code: RedirectCode; source: RedirectSource; note?: string | null; adminUserId?: number | null },
) {
  const from = cleanPath(input.from);
  if (!from) throw badRequest('Enter the old address, like /product/old-name/', { fromPath: 'Enter the old address' });
  if (isProtected(from)) throw badRequest('This address is part of the website and cannot be redirected', { fromPath: 'Cannot redirect this address' });
  let to = '';
  if (input.code !== 410) {
    const target = cleanTarget(input.to, ownHosts());
    if (!target) throw badRequest('Enter where it goes: an address on this website, like /product/new-name/', { toPath: 'An address on this website' });
    to = target;
    // Follow existing redirects from the target to its final place.
    for (let hop = 0; hop < 10; hop++) {
      const [next] = await tx.select().from(redirects).where(eq(redirects.fromPath, targetPathOf(to))).limit(1);
      if (!next) break;
      if (next.code === 410) throw badRequest('That address is marked as gone. Choose another one.', { toPath: 'This address is gone' });
      to = next.toPath;
    }
    if (targetPathOf(to) === from) throw badRequest('This would send the address back to itself', { toPath: 'Leads back to the old address' });
  }
  const values = { fromPath: from, toPath: to, code: input.code, source: input.source, note: input.note ?? null };
  const [row] = await tx
    .insert(redirects)
    .values({ ...values, createdBy: input.adminUserId ?? null })
    .onConflictDoUpdate({ target: redirects.fromPath, set: values })
    .returning();
  // Redirects that led to the old address now go straight to the new place (or are gone too).
  await tx
    .update(redirects)
    .set(input.code === 410 ? { toPath: '', code: 410 } : { toPath: to })
    .where(and(eq(redirects.toPath, from), sql`${redirects.id} <> ${row!.id}`));
  // It is handled now.
  await tx.delete(notFoundLog).where(eq(notFoundLog.path, from));
  return row!;
}

/**
 * A product, category or brand got a new address: the old one redirects to it (Google keeps the
 * ranking), and a redirect from the new address is removed (a real page lives there now).
 */
export async function addressChanged(tx: Tx | typeof db, oldPath: string, newPath: string) {
  const from = cleanPath(oldPath);
  const to = cleanPath(newPath);
  if (!from || !to || from === to) return;
  await tx.delete(redirects).where(eq(redirects.fromPath, to));
  await saveRedirect(tx, { from, to, code: 301, source: 'auto' });
}

/** A real page now lives at these addresses: they must not redirect any more. */
export async function addressesInUse(tx: Tx | typeof db, paths: string[]) {
  const clean = paths.map(cleanPath).filter((p): p is string => !!p);
  if (clean.length) await tx.delete(redirects).where(inArray(redirects.fromPath, clean));
}
