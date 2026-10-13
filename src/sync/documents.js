import { heroPages } from '../hero/client.js';
import { CUSTOMER_DOCUMENTS_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';
import { startArea, completeArea, endArea } from './area.js';
import { shortError } from '../utils/errors.js';

const nullIfZero = (v) => (v === 0 || v === null || v === undefined ? null : v);

async function writeDocuments(c, rows) {
  for (const d of rows) {
    const booking = d.customer_document_booking;
    await c.query(
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
        d.id, d.nr, d.type, d.status_code, d.status_name, d.date, d.value, d.vat, nullIfZero(d.project_match_id),
        booking?.is_open ?? null, booking?.due_date ?? null, booking?.paid_date ?? null,
        booking?.balance ?? null, booking?.status_name ?? null,
        safeJsonStringify(d),
      ]
    );
  }
  return rows.map((d) => d.id);
}

async function writeDrafts(c, rows) {
  const keys = [];
  for (const d of rows) {
    const draft = d.published_customer_document_draft;
    if (!draft) continue;
    await c.query(
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
      [draft.id, d.id, d.nr, nullIfZero(d.project_match_id), draft.name, draft.type, safeJsonStringify(draft.data ?? null), safeJsonStringify(draft)]
    );
    keys.push(draft.id);
  }
  return keys;
}

/**
 * Bereiche documents und document_drafts: ein HERO-Abruf, zwei Bereichslaeufe mit eigener Sperre und
 * eigener Verbindung. Ein Fehler beim Schreiben der Entwuerfe bricht den Belegabruf nicht ab
 * (Entwuerfe dann unvollstaendig/error). Ist documents gesperrt, wird der Abruf ganz uebersprungen.
 */
export async function syncDocumentAreas({ runId, mode }) {
  const docs = await startArea({ runId, area: 'documents', mode });
  if (!docs.run) {
    return { documents: docs.result, document_drafts: { bereich: 'document_drafts', status: 'uebersprungen', hinweis: 'documents nicht gestartet' } };
  }
  const drafts = await startArea({ runId, area: 'document_drafts', mode });
  let complete = false;
  let fetchError = null;
  let draftError = null;
  try {
    try {
      // Kleinere Seiten: published_customer_document_draft.data ist gross (500/Seite → HTTP 502 beobachtet).
      for await (const { rows, last } of heroPages(CUSTOMER_DOCUMENTS_QUERY, (d) => d?.customer_documents, { pageSize: 100 })) {
        await docs.run.writeTx((c) => writeDocuments(c, rows));
        if (drafts.run && !draftError) {
          try {
            await drafts.run.writeTx((c) => writeDrafts(c, rows));
          } catch (err) {
            draftError = err;
          }
        } else if (drafts.run) {
          // Entwuerfe stehen bereits auf Fehler: Sperre trotzdem halten, damit Abschluss/Freigabe sauber laufen
          try { await drafts.run.ensureLease(); } catch { /* Abschlussfehler wird protokolliert */ }
        }
        if (last) complete = true;
      }
    } catch (err) {
      fetchError = err;
    }
    const docResult = await completeArea(docs.run, docs.result, fetchError ? { error: fetchError } : { complete });
    let draftResult = drafts.result;
    if (drafts.run) {
      const err = fetchError ?? draftError;
      draftResult = await completeArea(drafts.run, drafts.result, err ? { error: err } : { complete });
      if (draftError && !fetchError) draftResult.fehler = shortError(draftError);
    }
    return { documents: docResult, document_drafts: draftResult };
  } finally {
    await endArea(docs.run, docs.result);
    if (drafts.run) await endArea(drafts.run, drafts.result);
  }
}
