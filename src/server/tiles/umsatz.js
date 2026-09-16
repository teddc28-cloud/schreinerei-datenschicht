import { pool } from '../../db/pool.js';

/**
 * 5.1 Umsatz laufender Monat.
 * Summe der Ausgangsrechnungen netto (documents.value ist bereits netto, siehe Schema-Kommentar),
 * Stichtag Rechnungsdatum. Vergleich mit gleichem Monat Vorjahr.
 */
export async function getUmsatzKachel(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1; // 1-12

  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(value) FILTER (
         WHERE EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2
       ), 0) AS aktuell,
       COALESCE(SUM(value) FILTER (
         WHERE EXTRACT(YEAR FROM date) = $1 - 1 AND EXTRACT(MONTH FROM date) = $2
       ), 0) AS vorjahr
     FROM documents
     WHERE type = 'invoice'`,
    [year, month]
  );

  const aktuell = Number(rows[0].aktuell);
  const vorjahr = Number(rows[0].vorjahr);
  const differenzEur = aktuell - vorjahr;
  const differenzProzent = vorjahr !== 0 ? (differenzEur / vorjahr) * 100 : null;

  return {
    umsatz_netto_eur: aktuell,
    vorjahresmonat_eur: vorjahr,
    differenz_eur: differenzEur,
    differenz_prozent: differenzProzent,
    monat: month,
    jahr: year,
  };
}
