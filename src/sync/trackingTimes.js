import { heroPages } from '../hero/client.js';
import { TRACKING_TIMES_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';
import { formatLocalDate } from '../utils/dates.js';

const nullIfZero = (v) => (v === 0 || v === null || v === undefined ? null : v);

/**
 * Monatsscheiben, aelteste zuerst. Datumsgrenzen in Ortszeit (process.env.TZ = Europe/Berlin, siehe src/tz.js).
 * HERO-Semantik geprueft am 12.10.2026: start/end sind Kalendertage, `end` ist INKLUSIV
 * (start=end=2026-09-30 liefert genau die Buchungen vom 30.09.).
 */
export function monthSlices(monthsBack, now = new Date()) {
  const slices = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    slices.push({ start: formatLocalDate(from), end: formatLocalDate(to) });
  }
  return slices;
}

/** Gesamtfenster ueber alle Scheiben (Pflicht fuer ds.begin_area_run bei zeitfenster-Bereichen). */
export function trackingWindow(monthsBack, now = new Date()) {
  const s = monthSlices(monthsBack, now);
  return { windowFrom: s[0].start, windowTo: s[s.length - 1].end, slices: s };
}

/**
 * monthsBack = 2  -> stuendlicher Sync (laufender + letzter Monat, faengt Nachtraege ab)
 * monthsBack = 3  -> naechtlicher Abgleich der letzten ~90 Tage
 * monthsBack = 25 -> Erstlauf, zwei volle Jahre plus Puffer
 */
export const MONTHS_BACK = { hourly: 2, nightly: 3, initial: 25, manual: 2 };

export async function syncTrackingTimes(run, { slices }) {
  for (const { start, end } of slices) {
    for await (const { rows } of heroPages((first, offset) => TRACKING_TIMES_QUERY(start, end, first, offset), (d) => d.tracking_times, { pageSize: 500 })) {
      await run.writeTx(async (c) => {
        for (const t of rows) {
          await c.query(
            `INSERT INTO tracking_times (uuid, start, "end", project_match_id, tracking_times_category_id, comment, synced_at, raw_json)
             VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
             ON CONFLICT (uuid) DO UPDATE SET
               start = EXCLUDED.start,
               "end" = EXCLUDED."end",
               project_match_id = EXCLUDED.project_match_id,
               tracking_times_category_id = EXCLUDED.tracking_times_category_id,
               comment = EXCLUDED.comment,
               synced_at = now(),
               raw_json = EXCLUDED.raw_json`,
            [t.uuid, t.start, t.end, nullIfZero(t.project_match_id), t.tracking_times_category_id, t.comment, safeJsonStringify(t)]
          );
        }
        return rows.map((t) => t.uuid);
      });
    }
  }
  return { complete: true };
}
