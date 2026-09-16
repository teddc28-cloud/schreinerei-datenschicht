import { dbQuery } from '../db/pool.js';
import { heroQuery } from '../hero/client.js';
import { TRACKING_TIMES_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

const nullIfZero = (v) => (v === 0 || v === null || v === undefined ? null : v);

// toISOString() rechnet auf UTC um und verschiebt das Datum je nach Server-Zeitzone
// um bis zu einen Tag - stattdessen aus den lokalen Datumskomponenten formatieren.
function formatLocalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthSlices(monthsBack) {
  const slices = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    slices.push({
      start: formatLocalDate(from),
      end: formatLocalDate(to),
    });
  }
  return slices;
}

async function syncWindow(start, end) {
  const pageSize = 500;
  let offset = 0;
  let total = 0;

  while (true) {
    const data = await heroQuery(TRACKING_TIMES_QUERY(start, end, pageSize, offset));
    const rows = data.tracking_times;

    for (const t of rows) {
      await dbQuery(
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

    total += rows.length;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return total;
}

/**
 * monthsBack = 1  -> stuendlicher Sync (laufender + letzter Monat, faengt Nachtraege ab)
 * monthsBack = 3  -> naechtlicher Vollabgleich der letzten ~90 Tage
 * monthsBack = 25 -> Erstlauf, zwei volle Jahre plus Puffer
 */
export async function syncTrackingTimes({ monthsBack = 1 } = {}) {
  let total = 0;
  for (const { start, end } of monthSlices(monthsBack)) {
    total += await syncWindow(start, end);
  }
  return { count: total };
}
