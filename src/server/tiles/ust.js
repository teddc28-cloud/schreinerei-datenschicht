import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';

/**
 * 5.3 Umsatzsteuer-Zahllast Folgemonat.
 * Zahllast = USt aus Ausgangsrechnungen des laufenden Monats - Vorsteuer aus Eingangsrechnungen des laufenden Monats.
 * Soll-Versteuerung (Rechnungsstellung), passt zur Umsatzkachel. Faellig ist die Zahllast im Folgemonat -
 * das betrifft nur die Beschriftung, nicht die Berechnung (die laeuft auf dem laufenden Monat).
 */
export async function getUstKachel(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;

  const [{ rows: ustRows }, { rows: vorsteuerRows }, warnschwelle] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vat), 0) AS ust
       FROM documents
       WHERE type = 'invoice' AND EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT COALESCE(SUM(vat), 0) AS vorsteuer, COUNT(*) AS anzahl
       FROM receipts
       WHERE EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2`,
      [year, month]
    ),
    getParameterNumber('eingangsrechnungen_warnschwelle', 3),
  ]);

  const ust = Number(ustRows[0].ust);
  const vorsteuer = Number(vorsteuerRows[0].vorsteuer);
  const anzahlEingangsrechnungen = Number(vorsteuerRows[0].anzahl);
  const zahllast = ust - vorsteuer;

  const faelligMonat = month === 12 ? 1 : month + 1;
  const faelligJahr = month === 12 ? year + 1 : year;

  return {
    zahllast_eur: Math.round(zahllast * 100) / 100,
    ust_eur: Math.round(ust * 100) / 100,
    vorsteuer_eur: Math.round(vorsteuer * 100) / 100,
    anzahl_eingangsrechnungen: anzahlEingangsrechnungen,
    wenige_eingangsrechnungen: anzahlEingangsrechnungen < warnschwelle,
    monat: month,
    jahr: year,
    faellig_monat: faelligMonat,
    faellig_jahr: faelligJahr,
  };
}
