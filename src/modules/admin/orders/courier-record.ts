import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { courierChecks, type CourierLevel } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import { logger } from '../../../lib/logger.ts';
import { getIntegration } from '../integrations/service.ts';
import { call } from './steadfast.ts';

/**
 * A customer's courier record (Steadfast's "fraud check"): how much of this phone number's parcels,
 * with every merchant, was delivered or came back, and what other merchants reported. Saved per phone
 * for a few days: Steadfast allows only a few checks a day (about 4 per parcel booked on the busiest
 * day last week, plus 10). Information for staff: never blocks an order.
 */

/** A saved check is used for this long; then the next look asks again. */
const FRESH_DAYS = 3;
/** "Check now" asks Steadfast at most this often per number. */
const MIN_GAP_MS = 60_000;

export interface CourierRecord {
  /** Whole percents of the number's finished parcels (null: nothing finished yet = unknown, not clean). */
  deliveryRatio: number | null;
  cancellationRatio: number | null;
  /** none, low (1–5), medium (6–20), high (21–200), very_high (200+). */
  volumeBand: string | null;
  /** "7", "10+", "50+"... */
  volumeRange: string | null;
  deliveredCount: number | null;
  cancelledCount: number | null;
  totalReports: number;
  /** What other merchants reported, worst first: { code: times }. */
  reports: { code: string; times: number }[];
  doubtfulReports: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Steadfast's answer, read carefully (missing or odd values stay unknown). */
export function readRecord(d: Record<string, unknown>): CourierRecord {
  const cats = d.fraud_categories;
  const reports =
    cats && typeof cats === 'object' && !Array.isArray(cats)
      ? Object.entries(cats as Record<string, unknown>)
          .map(([code, times]) => ({ code: code.slice(0, 60), times: num(times) ?? 0 }))
          .filter((r) => r.times > 0)
          .sort((a, b) => b.times - a.times)
          .slice(0, 10)
      : [];
  return {
    deliveryRatio: num(d.delivery_ratio),
    cancellationRatio: num(d.cancellation_ratio),
    volumeBand: typeof d.volume_band === 'string' ? d.volume_band.slice(0, 20) : null,
    volumeRange: typeof d.volume_range === 'string' ? d.volume_range.slice(0, 20) : null,
    deliveredCount: num(d.delivered_count),
    cancelledCount: num(d.cancelled_count),
    totalReports: num(d.total_reports) ?? 0,
    reports,
    doubtfulReports: d.doubtful_reports === true,
  };
}

/**
 * The shop's simple reading of a record. risky: 30%+ came back, or 3+ reports; watch: 15%+ came
 * back, or any report; unknown: nothing finished yet; else good.
 */
export function levelOf(r: CourierRecord): CourierLevel {
  if (r.cancellationRatio === null && r.deliveryRatio === null) return r.totalReports >= 3 ? 'risky' : r.totalReports > 0 ? 'watch' : 'unknown';
  const cancelled = r.cancellationRatio ?? 0;
  if (cancelled >= 30 || r.totalReports >= 3) return 'risky';
  if (cancelled >= 15 || r.totalReports >= 1) return 'watch';
  return 'good';
}

export interface SavedRecord {
  phone: string;
  level: CourierLevel;
  record: CourierRecord;
  checkedAt: string;
}

const view = (row: typeof courierChecks.$inferSelect): SavedRecord => ({
  phone: row.phone,
  level: row.level,
  record: row.data as CourierRecord,
  checkedAt: row.checkedAt.toISOString(),
});

/** The saved record of a number (no call to Steadfast). */
export async function savedRecord(phone: string) {
  const [row] = await db.select().from(courierChecks).where(eq(courierChecks.phone, phone));
  return row ? view(row) : null;
}

/** Can the shop check numbers? (Keys saved; sending may be off: checking only reads.) */
export async function canCheck() {
  const { secrets } = await getIntegration('steadfast');
  return !!(secrets.apiKey && secrets.secretKey);
}

/**
 * The record of a number: the saved one while fresh, else asked from Steadfast and saved.
 * `force` (Check now) asks again unless asked in the last minute.
 */
export async function courierRecord(phone: string, opts: { force?: boolean } = {}): Promise<SavedRecord> {
  if (!/^01\d{9}$/.test(phone)) throw badRequest('Not a Bangladeshi mobile number');
  const saved = await savedRecord(phone);
  const age = saved ? Date.now() - new Date(saved.checkedAt).getTime() : Infinity;
  if (saved && (opts.force ? age < MIN_GAP_MS : age < FRESH_DAYS * 86_400_000)) return saved;

  const answer = await call<Record<string, unknown>>('GET', `/fraud_check/score/${phone}`);
  if (!answer.ok || !answer.data || Number(answer.data.status) !== 200) {
    const why =
      'error' in answer && answer.error
        ? answer.error
        : answer.httpStatus === 429
          ? 'Steadfast allows only a few checks a day: try again later.'
          : answer.httpStatus === 401
            ? 'Steadfast did not accept the API keys (Integrations → Steadfast).'
            : `Steadfast could not check this number (${answer.httpStatus || 'no answer'}).`;
    logger.warn({ phone: phone.slice(0, 5), status: answer.httpStatus }, 'Courier record check failed');
    // A failed check keeps the last one (better than nothing), and says why.
    if (saved) return saved;
    throw badRequest(why);
  }
  const record = readRecord(answer.data);
  const level = levelOf(record);
  const [row] = await db
    .insert(courierChecks)
    .values({ phone, level, data: record, checkedAt: new Date() })
    .onConflictDoUpdate({ target: courierChecks.phone, set: { level, data: record, checkedAt: new Date() } })
    .returning();
  return view(row!);
}

/** For a new website order (background job): check the number unless a fresh check is saved. Never throws. */
export async function checkInBackground(phone: string) {
  try {
    if (!(await canCheck())) return;
    await courierRecord(phone);
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'Courier record not checked');
  }
}
