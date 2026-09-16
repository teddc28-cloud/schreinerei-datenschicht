import { pool } from '../../db/pool.js';

/**
 * 5.4 Offene und ueberfaellige Forderungen.
 * Basis: bestehendes Skript liquiditaet.mjs (customer_document_booking.is_open/due_date/balance),
 * Datenzugriff auf die Datenbank umgestellt. Altersstruktur-Grenzen wie im Pflichtenheft:
 * bis 14 Tage / 15-30 / 31-60 / ueber 60 Tage (Tage seit Faelligkeit).
 */
export async function getForderungenKachel(referenceDate = new Date()) {
  const { rows } = await pool.query(
    `SELECT nr, value, booking_due_date, booking_balance
     FROM documents
     WHERE type = 'invoice' AND booking_is_open = true`
  );

  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

  const buckets = {
    nicht_faellig: { anzahl: 0, betrag: 0 },
    bis_14: { anzahl: 0, betrag: 0 },
    '15_30': { anzahl: 0, betrag: 0 },
    '31_60': { anzahl: 0, betrag: 0 },
    ueber_60: { anzahl: 0, betrag: 0 },
  };

  let gesamtAnzahl = 0;
  let gesamtBetrag = 0;
  let ueberfaelligAnzahl = 0;
  let ueberfaelligBetrag = 0;

  for (const r of rows) {
    const betrag = Number(r.booking_balance ?? r.value ?? 0);
    gesamtAnzahl += 1;
    gesamtBetrag += betrag;

    const dueDate = r.booking_due_date ? new Date(r.booking_due_date) : null;
    const tageUeberfaellig = dueDate ? Math.floor((today - dueDate) / 86400000) : -1;

    let bucket;
    if (!dueDate || tageUeberfaellig <= 0) bucket = 'nicht_faellig';
    else if (tageUeberfaellig <= 14) bucket = 'bis_14';
    else if (tageUeberfaellig <= 30) bucket = '15_30';
    else if (tageUeberfaellig <= 60) bucket = '31_60';
    else bucket = 'ueber_60';

    buckets[bucket].anzahl += 1;
    buckets[bucket].betrag += betrag;

    if (bucket !== 'nicht_faellig') {
      ueberfaelligAnzahl += 1;
      ueberfaelligBetrag += betrag;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  for (const b of Object.values(buckets)) b.betrag = round2(b.betrag);

  return {
    gesamt_anzahl: gesamtAnzahl,
    gesamt_eur: round2(gesamtBetrag),
    ueberfaellig_anzahl: ueberfaelligAnzahl,
    ueberfaellig_eur: round2(ueberfaelligBetrag),
    buckets,
  };
}
