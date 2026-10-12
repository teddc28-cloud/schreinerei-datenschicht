import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';
import { startOfDay, addDays } from '../../utils/dates.js';

/**
 * Kachel 4 - "Kommt noch was rein?" (vorlaufende Kennzahl).
 * Rollierendes 3-Monats-Fenster = laufender Monat (bis heute) + die zwei vollen Monate davor -
 * bewusst inkl. laufendem Monat, damit die Kennzahl so aktuell wie moeglich bleibt.
 * status_code 600 (Storniert) und 1000 (Geloescht) ausgefiltert, alles andere (auch Entwuerfe)
 * zaehlt mit - so wie im Auftrag spezifiziert.
 * Kein Monatsvergleich: bei 8-50 Angeboten/Monat ist das Rauschen, daher nur 3-Monats-Fenster.
 */
export async function getPipelineKachel(referenceDate = new Date()) {
  const heute = startOfDay(referenceDate);
  const breakEven = await getParameterNumber('break_even_monat', 45169);

  // Fensteranfaenge: laufender Monat minus 2 = Start des aktuellen 3-Monats-Fensters.
  const fensterAktuellStart = new Date(heute.getFullYear(), heute.getMonth() - 2, 1);
  const fensterAktuellEnde = heute;

  const fensterVorherStart = new Date(heute.getFullYear(), heute.getMonth() - 5, 1);
  const fensterVorherEnde = addDays(fensterAktuellStart, -1);

  const fensterVorjahrStart = new Date(fensterAktuellStart.getFullYear() - 1, fensterAktuellStart.getMonth(), 1);
  const fensterVorjahrEnde = new Date(fensterAktuellEnde.getFullYear() - 1, fensterAktuellEnde.getMonth(), fensterAktuellEnde.getDate());

  async function summeUndAnzahl(type, von, bis) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS anzahl, COALESCE(SUM(value), 0) AS volumen
       FROM documents
       WHERE type = $1 AND status_code NOT IN ('600', '1000') AND deleted_at IS NULL
         AND date >= $2 AND date <= $3`,
      [type, von, bis]
    );
    return { anzahl: Number(rows[0].anzahl), volumen_eur: Number(rows[0].volumen) };
  }

  const [
    angeboteAktuell,
    abAktuell,
    angeboteVorher,
    abVorher,
    angeboteVorjahr,
    abVorjahr,
  ] = await Promise.all([
    summeUndAnzahl('offer', fensterAktuellStart, fensterAktuellEnde),
    summeUndAnzahl('confirmation', fensterAktuellStart, fensterAktuellEnde),
    summeUndAnzahl('offer', fensterVorherStart, fensterVorherEnde),
    summeUndAnzahl('confirmation', fensterVorherStart, fensterVorherEnde),
    summeUndAnzahl('offer', fensterVorjahrStart, fensterVorjahrEnde),
    summeUndAnzahl('confirmation', fensterVorjahrStart, fensterVorjahrEnde),
  ]);

  const round2 = (n) => Math.round(n * 100) / 100;
  const wandlungsquote = (ab, angebote) => (angebote.anzahl > 0 ? round2((ab.anzahl / angebote.anzahl) * 100) : null);
  // Veraenderung der AB-Volumen-Kernzahl gg. Vergleichszeitraum, fuer kompakte Pfeil-Chips
  // statt ausformulierter Vergleichssaetze.
  const veraenderung = (basis) => (basis.volumen_eur > 0 ? round2(((abAktuell.volumen_eur - basis.volumen_eur) / basis.volumen_eur) * 100) : null);

  const ampelSchwelle = breakEven * 3;

  return {
    fenster: { von: fmt(fensterAktuellStart), bis: fmt(fensterAktuellEnde) },
    angebote: { ...angeboteAktuell, volumen_eur: round2(angeboteAktuell.volumen_eur) },
    auftragseingang: { ...abAktuell, volumen_eur: round2(abAktuell.volumen_eur) },
    wandlungsquote_prozent: wandlungsquote(abAktuell, angeboteAktuell),
    ampel_schwelle_eur: ampelSchwelle,
    rot: abAktuell.volumen_eur < ampelSchwelle,
    vergleich_vorher_prozent: veraenderung({ volumen_eur: round2(abVorher.volumen_eur) }),
    vergleich_vorjahr_prozent: veraenderung({ volumen_eur: round2(abVorjahr.volumen_eur) }),
  };
}

function fmt(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
