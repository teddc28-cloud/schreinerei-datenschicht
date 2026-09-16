import { dbQuery } from '../db/pool.js';
import { heroQueryAllPages } from '../hero/client.js';
import { CUSTOMER_DOCUMENTS_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

const nullIfZero = (v) => (v === 0 || v === null || v === undefined ? null : v);

export async function syncDocuments() {
  // Kleinere Seiten als Standard: published_customer_document_draft.data kann pro Dokument
  // recht gross sein, das hat die Hero API bei 500/Seite schon mit 502 quittiert.
  const rows = await heroQueryAllPages(CUSTOMER_DOCUMENTS_QUERY, 'customer_documents', { pageSize: 100 });

  let draftCount = 0;

  for (const d of rows) {
    const projectMatchId = nullIfZero(d.project_match_id);
    const booking = d.customer_document_booking;

    await dbQuery(
      `INSERT INTO documents (
         id, nr, type, status_code, status_name, date, value, vat, project_match_id,
         booking_is_open, booking_due_date, booking_paid_date, booking_balance, booking_status_name,
         synced_at, raw_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), $15)
       ON CONFLICT (id) DO UPDATE SET
         nr = EXCLUDED.nr,
         type = EXCLUDED.type,
         status_code = EXCLUDED.status_code,
         status_name = EXCLUDED.status_name,
         date = EXCLUDED.date,
         value = EXCLUDED.value,
         vat = EXCLUDED.vat,
         project_match_id = EXCLUDED.project_match_id,
         booking_is_open = EXCLUDED.booking_is_open,
         booking_due_date = EXCLUDED.booking_due_date,
         booking_paid_date = EXCLUDED.booking_paid_date,
         booking_balance = EXCLUDED.booking_balance,
         booking_status_name = EXCLUDED.booking_status_name,
         synced_at = now(),
         raw_json = EXCLUDED.raw_json`,
      [
        d.id, d.nr, d.type, d.status_code, d.status_name, d.date, d.value, d.vat, projectMatchId,
        booking?.is_open ?? null, booking?.due_date ?? null, booking?.paid_date ?? null,
        booking?.balance ?? null, booking?.status_name ?? null,
        safeJsonStringify(d),
      ]
    );

    const draft = d.published_customer_document_draft;
    if (draft) {
      await dbQuery(
        `INSERT INTO document_drafts (id, document_id, document_nr, project_match_id, name, type, data, synced_at, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           document_nr = EXCLUDED.document_nr,
           project_match_id = EXCLUDED.project_match_id,
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           data = EXCLUDED.data,
           synced_at = now(),
           raw_json = EXCLUDED.raw_json`,
        [draft.id, d.id, d.nr, projectMatchId, draft.name, draft.type, safeJsonStringify(draft.data ?? null), safeJsonStringify(draft)]
      );
      draftCount += 1;
    }
  }

  return { count: rows.length, drafts: draftCount };
}
