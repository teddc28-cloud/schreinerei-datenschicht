import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';
import { PRODUKTIVE_KATEGORIEN } from './produktiveKategorien.js';
import { getAktiveProjekteStunden } from './aktiveProjekteStunden.js';
import { mondayOfWeek, addDays } from '../../utils/dates.js';

// Projekte mit Status "In Umsetzung" ODER "Kundenrechnung" zaehlen als aktiv fuer die
// Kapazitaetsauslastung: Hero dreht den Status offenbar schon auf "Kundenrechnung", sobald
// die erste Teilrechnung raus ist, auch wenn noch gearbeitet wird - die meisten echten
// Ist-Stunden haengen an diesem Status, nicht an "In Umsetzung" (siehe aktiveProjekteStunden.js).
const WERKSTATT_STATUS = ['In Umsetzung', 'Kundenrechnung'];

/**
 * Kachel 2 - "Laeuft die Werkstatt wirtschaftlich?"
 * Soll-Ist-Quote der aktiven Projekte (Summe Ist / Summe Soll, nicht Durchschnitt der
 * Einzelquoten - grosse Projekte zaehlen damit angemessen staerker).
 * Gebuchte Stunden LETZTE (volle, abgeschlossene) Woche - betriebsweit, nicht projektgebunden.
 */
export async function getWerkstattKachel(referenceDate = new Date()) {
  const [zielSollIst, zielStundenWoche, { anzahl_laufend, projekte }] = await Promise.all([
    getParameterNumber('ziel_soll_ist', 1.05),
    getParameterNumber('ziel_stunden_woche', 100),
    getAktiveProjekteStunden(WERKSTATT_STATUS),
  ]);

  const summeSoll = projekte.reduce((s, p) => s + p.soll_stunden, 0);
  const summeIst = projekte.reduce((s, p) => s + p.ist_stunden, 0);
  const sollIstQuote = summeSoll > 0 ? summeIst / summeSoll : null;

  const montagLetzteWoche = addDays(mondayOfWeek(referenceDate), -7);
  const sonntagLetzteWoche = addDays(montagLetzteWoche, 7); // exklusiv, Montagmorgen der laufenden Woche

  const { rows: wochenRows } = await pool.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM ("end" - start))), 0) / 3600 AS stunden
     FROM tracking_times
     WHERE tracking_times_category_id = ANY($1) AND "end" IS NOT NULL AND deleted_at IS NULL
       AND start >= $2 AND start < $3`,
    [PRODUKTIVE_KATEGORIEN, montagLetzteWoche, sonntagLetzteWoche]
  );
  const stundenLetzteWoche = Number(wochenRows[0].stunden);

  const round2 = (n) => Math.round(n * 100) / 100;

  const ueberschreitungen = projekte
    .filter((p) => p.abweichung_stunden > 0)
    .sort((a, b) => b.abweichung_stunden - a.abweichung_stunden)
    .slice(0, 3)
    .map((p) => ({
      display_id: p.display_id,
      name: p.name,
      abweichung_stunden: p.abweichung_stunden,
      ist_stunden: p.ist_stunden,
      soll_stunden: p.soll_stunden,
    }));

  const ampelSollIst = sollIstQuote === null ? 'grau' : sollIstQuote >= zielSollIst ? 'rot' : 'gruen';
  const ampelStunden = stundenLetzteWoche < zielStundenWoche ? 'gelb' : 'gruen';

  // Kachel-Rahmen zeigt die schlechtere der beiden Einzelampeln, damit "auf einen Blick"
  // kein rot/gelb hinter einem gruenen Rahmen versteckt bleibt.
  const schwere = { rot: 3, gelb: 2, gruen: 1, grau: 0 };
  const ampelGesamt = schwere[ampelSollIst] >= schwere[ampelStunden] ? ampelSollIst : ampelStunden;

  return {
    anzahl_laufend,
    ampel: ampelGesamt,
    soll_ist_quote_prozent: sollIstQuote === null ? null : round2(sollIstQuote * 100),
    ziel_soll_ist_prozent: round2(zielSollIst * 100),
    ampel_soll_ist: ampelSollIst,
    stunden_letzte_woche: round2(stundenLetzteWoche),
    ziel_stunden_woche: zielStundenWoche,
    ampel_stunden: ampelStunden,
    ueberschreitungen,
  };
}
