import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** YYYY-MM-DD aus den lokalen Datumskomponenten - toISOString() rechnet auf UTC um und
 * verschiebt dadurch das Datum je nach Server-Zeitzone um bis zu einen Tag. */
function formatLocalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Montag der Woche, in der `date` liegt (lokale Kalenderwoche, nicht rollierend). */
function mondayOfWeek(date) {
  const d = startOfDay(date);
  const dayIndex = (d.getDay() + 6) % 7; // Montag = 0 .. Sonntag = 6
  return addDays(d, -dayIndex);
}

/** ISO-8601-Kalenderwoche (deutsche Zaehlweise, Montag-Start, KW 1 enthaelt den ersten Donnerstag des Jahres). */
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return { woche: 1 + Math.round((d - firstThursday) / (7 * 86400000)), jahr: d.getUTCFullYear() };
}

/** Fixkosten-Betrag fuer ein Datum: Summe aller aktiven Zeilen mit tag_im_monat == Tag dieses Datums. */
function fixedCostsForDate(fixedCosts, date) {
  const day = date.getDate();
  return fixedCosts
    .filter((f) => f.aktiv && Number(f.tag_im_monat) === day)
    .reduce((sum, f) => sum + Number(f.betrag), 0);
}

/**
 * 5.6 Liquiditaetsvorschau 6-8 Wochen.
 * Startwert Kontostand (Parameter) + offene Forderungen auf Faelligkeitsdatum
 * - offene Verbindlichkeiten auf Faelligkeitsdatum - Fixkosten aus fixed_costs auf ihren Stichtag.
 * Ueberfaellige Posten (Faelligkeit in der Vergangenheit) werden in Woche 1 einsortiert -
 * das Geld ist ueberfaellig, koennte also jederzeit kommen/gehen.
 */
export async function getLiquiditaetKachel(referenceDate = new Date()) {
  const [kontostand, horizontWochen] = await Promise.all([
    getParameterNumber('kontostand', 0),
    getParameterNumber('liquiditaet_horizont', 8),
  ]);

  const heute = startOfDay(referenceDate);
  const montagAktuelleWoche = mondayOfWeek(heute);
  const horizontEnde = addDays(montagAktuelleWoche, horizontWochen * 7);

  const [{ rows: forderungen }, { rows: verbindlichkeiten }, { rows: fixedCosts }] = await Promise.all([
    pool.query(
      `SELECT booking_due_date AS due_date, booking_balance AS betrag
       FROM documents
       WHERE type = 'invoice' AND booking_is_open = true`
    ),
    pool.query(
      `SELECT due_date, open_amount AS betrag
       FROM receipts
       WHERE paid_date IS NULL AND open_amount IS NOT NULL AND open_amount > 0`
    ),
    pool.query(`SELECT bezeichnung, betrag, tag_im_monat, aktiv FROM fixed_costs WHERE aktiv = true`),
  ]);

  const wochen = [];
  let laufenderSaldo = kontostand;

  for (let w = 0; w < horizontWochen; w++) {
    const wochenStart = addDays(montagAktuelleWoche, w * 7);
    const wochenEnde = addDays(wochenStart, 6);
    const { woche: kw, jahr: kwJahr } = isoWeekNumber(wochenStart);

    const inWoche = (dueDate) => {
      if (!dueDate) return false;
      const d = startOfDay(new Date(dueDate));
      if (w === 0) return d <= wochenEnde; // ueberfaellige + diese Woche faellige zusammen in Woche 1
      return d >= wochenStart && d <= wochenEnde;
    };

    const zufluss = forderungen
      .filter((f) => inWoche(f.due_date))
      .reduce((s, f) => s + Number(f.betrag ?? 0), 0);

    const abflussVerbindlichkeiten = verbindlichkeiten
      .filter((v) => inWoche(v.due_date))
      .reduce((s, v) => s + Number(v.betrag ?? 0), 0);

    let fixkosten = 0;
    for (let d = wochenStart; d <= wochenEnde && d <= horizontEnde; d = addDays(d, 1)) {
      fixkosten += fixedCostsForDate(fixedCosts, d);
    }

    laufenderSaldo = laufenderSaldo + zufluss - abflussVerbindlichkeiten - fixkosten;

    wochen.push({
      woche: w + 1,
      kw,
      kw_jahr: kwJahr,
      von: formatLocalDate(wochenStart),
      bis: formatLocalDate(wochenEnde),
      zufluss_forderungen_eur: Math.round(zufluss * 100) / 100,
      abfluss_verbindlichkeiten_eur: Math.round(abflussVerbindlichkeiten * 100) / 100,
      abfluss_fixkosten_eur: Math.round(fixkosten * 100) / 100,
      saldo_eur: Math.round(laufenderSaldo * 100) / 100,
    });
  }

  return {
    kontostand_eur: kontostand,
    horizont_wochen: horizontWochen,
    wochen,
  };
}
