import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';

/**
 * Kachel 1 - "Reicht's diesen Monat?"
 * Fakturiert seit Monatsanfang (netto) gegen Break-Even. Nur echte, verschickte
 * Rechnungen zaehlen (status_code 100 Erstellt oder 200 Versendet) - Entwuerfe (0),
 * Storno (600) und geloeschte (1000) fliessen nicht ein.
 * value ist bereits netto (verifiziert: value + vat = brutto, vat = 19% von value) -
 * keine Division noetig.
 */
export async function getReichtsKachel(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;

  const [breakEven, { rows: aktuellRows }, { rows: schnittRows }] = await Promise.all([
    getParameterNumber('break_even_monat', 45169),
    pool.query(
      `SELECT COALESCE(SUM(value), 0) AS summe
       FROM documents
       WHERE type = 'invoice' AND status_code IN ('100', '200') AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2`,
      [year, month]
    ),
    // Schnitt der letzten drei VOLLEN Monate vor dem laufenden Monat (fairer Vergleichswert,
    // der laufende Monat ist ja noch nicht abgeschlossen).
    pool.query(
      `SELECT EXTRACT(YEAR FROM date) AS jahr, EXTRACT(MONTH FROM date) AS monat, SUM(value) AS summe
       FROM documents
       WHERE type = 'invoice' AND status_code IN ('100', '200') AND deleted_at IS NULL
         AND date >= (date_trunc('month', $1::date) - interval '3 months')
         AND date < date_trunc('month', $1::date)
       GROUP BY 1, 2`,
      [referenceDate]
    ),
  ]);

  const fakturiert = Number(aktuellRows[0].summe);
  const quoteProzent = breakEven > 0 ? (fakturiert / breakEven) * 100 : null;

  const ampel = quoteProzent === null ? 'grau' : quoteProzent >= 100 ? 'gruen' : quoteProzent >= 85 ? 'gelb' : 'rot';

  // Immer durch 3 teilen, auch wenn ein Monat 0 Rechnungen hatte (echter Schnitt, keine Luecken verstecken).
  const summeLetzte3 = schnittRows.reduce((s, r) => s + Number(r.summe ?? 0), 0);
  const schnittLetzte3Monate = summeLetzte3 / 3;

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    fakturiert_eur: round2(fakturiert),
    break_even_eur: breakEven,
    quote_prozent: quoteProzent === null ? null : round2(quoteProzent),
    ampel,
    schnitt_letzte_3_monate_eur: round2(schnittLetzte3Monate),
    monat: month,
    jahr: year,
  };
}
