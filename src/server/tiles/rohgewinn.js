import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';
import { PRODUKTIVE_KATEGORIEN } from './produktiveKategorien.js';

async function periodValues(year, month) {
  const [{ rows: umsatzRows }, { rows: materialRows }, { rows: stundenRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(value), 0) AS umsatz
       FROM documents
       WHERE type = 'invoice' AND EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2`,
      [year, month]
    ),
    pool.query(
      // Materialkosten + Fremdleistungen: mangels projektbezogener Ist-Materialkosten (Pflichtenheft 8.1)
      // auf Betriebsebene aus allen Eingangsrechnungen des Monats genaehert (Empfehlung "Variante 2").
      `SELECT COALESCE(SUM(value), 0) AS material
       FROM receipts
       WHERE EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM ("end" - start))), 0) / 3600 AS stunden
       FROM tracking_times
       WHERE tracking_times_category_id = ANY($1)
         AND EXTRACT(YEAR FROM start) = $2 AND EXTRACT(MONTH FROM start) = $3
         AND "end" IS NOT NULL`,
      [PRODUKTIVE_KATEGORIEN, year, month]
    ),
  ]);

  const umsatz = Number(umsatzRows[0].umsatz);
  const material = Number(materialRows[0].material);
  const istStunden = Number(stundenRows[0].stunden);

  return { umsatz, material, istStunden };
}

/**
 * 5.2 Rohgewinn laufender Monat.
 * Rohgewinn = Umsatz netto - Materialkosten - Fremdleistungen - Fertigungsloehne (Ist-Stunden x Stundensatz Selbstkosten)
 * Nicht der steuerliche Gewinn (Miete, Leasing, Versicherungen, Verwaltung fehlen bewusst).
 */
export async function getRohgewinnKachel(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;

  const stundensatz = await getParameterNumber('stundensatz_selbstkosten', 58.12);

  const [aktuell, vorjahr] = await Promise.all([
    periodValues(year, month),
    periodValues(year - 1, month),
  ]);

  const round2 = (n) => Math.round(n * 100) / 100;

  const compute = (p) => {
    const fertigungsloehne = p.istStunden * stundensatz;
    const rohgewinn = p.umsatz - p.material - fertigungsloehne;
    return {
      umsatz_eur: round2(p.umsatz),
      material_fremdleistungen_eur: round2(p.material),
      ist_stunden: round2(p.istStunden),
      fertigungsloehne_eur: round2(fertigungsloehne),
      rohgewinn_eur: round2(rohgewinn),
    };
  };

  const a = compute(aktuell);
  const v = compute(vorjahr);
  const differenzEur = a.rohgewinn_eur - v.rohgewinn_eur;
  const differenzProzent = v.rohgewinn_eur !== 0 ? (differenzEur / Math.abs(v.rohgewinn_eur)) * 100 : null;

  return {
    ...a,
    vorjahresmonat_rohgewinn_eur: v.rohgewinn_eur,
    differenz_eur: round2(differenzEur),
    differenz_prozent: differenzProzent,
    stundensatz_selbstkosten: stundensatz,
    monat: month,
    jahr: year,
  };
}
