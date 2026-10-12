import { pool } from '../../db/pool.js';
import { OFFENE_RECHNUNGEN_WHERE } from './offeneRechnungen.js';
import { getParameterNumber } from '../../db/parameters.js';
import { startOfDay, addDays } from '../../utils/dates.js';

/** Naechster Termin einer Fixkosten-Zeile ab `heute` (Tag im Monat, ggf. in den Folgemonat projiziert). */
function naechsterTermin(tagImMonat, heute) {
  let kandidat = new Date(heute.getFullYear(), heute.getMonth(), tagImMonat);
  if (kandidat < heute) {
    kandidat = new Date(heute.getFullYear(), heute.getMonth() + 1, tagImMonat);
  }
  return kandidat;
}

/**
 * Kachel 3 - "Reicht das Geld?"
 * Eine Zeile, fuenf Zahlen: Kontostand, freier Rahmen der Linie, Forderungen faellig/ueberfaellig,
 * Verbindlichkeiten faellig/ueberfaellig, naechste Faelligkeit (aus fixed_costs - SV/Loehne/USt
 * tragen sich dort als eigene Zeilen ein, siehe Einstellungen).
 */
export async function getGeldKachel(referenceDate = new Date()) {
  const heute = startOfDay(referenceDate);

  const [kontostand, kkLinie, { rows: forderungen }, { rows: verbindlichkeiten }, { rows: fixedCosts }] =
    await Promise.all([
      getParameterNumber('kontostand', 0),
      getParameterNumber('kk_linie', 30000),
      pool.query(
        `SELECT booking_due_date AS due_date, booking_balance AS betrag
         FROM documents
         WHERE ${OFFENE_RECHNUNGEN_WHERE}`
      ),
      pool.query(
        `SELECT due_date, open_amount AS betrag
         FROM receipts
         WHERE paid_date IS NULL AND open_amount IS NOT NULL AND open_amount > 0 AND deleted_at IS NULL`
      ),
      pool.query(`SELECT bezeichnung, betrag, tag_im_monat FROM fixed_costs WHERE aktiv = true`),
    ]);

  const freierRahmen = kontostand < 0 ? kkLinie + kontostand : kkLinie;

  const round2 = (n) => Math.round(n * 100) / 100;

  const summiere = (rows) => {
    let faellig = 0;
    let ueberfaellig = 0;
    for (const r of rows) {
      const betrag = Number(r.betrag ?? 0);
      if (!r.due_date) continue;
      const due = startOfDay(new Date(r.due_date));
      if (due <= heute) {
        faellig += betrag;
        if (due < heute) ueberfaellig += betrag;
      }
    }
    return { faellig: round2(faellig), ueberfaellig: round2(ueberfaellig) };
  };

  const forderungenSummen = summiere(forderungen);
  const verbindlichkeitenSummen = summiere(verbindlichkeiten);

  let naechsteFaelligkeit = null;
  for (const f of fixedCosts) {
    const termin = naechsterTermin(Number(f.tag_im_monat), heute);
    if (!naechsteFaelligkeit || termin < naechsteFaelligkeit.datum) {
      naechsteFaelligkeit = { bezeichnung: f.bezeichnung, betrag: Number(f.betrag), datum: termin };
    }
  }

  return {
    kontostand_eur: kontostand,
    freier_rahmen_eur: round2(freierRahmen),
    kk_linie_eur: kkLinie,
    forderungen_faellig_eur: forderungenSummen.faellig,
    forderungen_ueberfaellig_eur: forderungenSummen.ueberfaellig,
    verbindlichkeiten_faellig_eur: verbindlichkeitenSummen.faellig,
    verbindlichkeiten_ueberfaellig_eur: verbindlichkeitenSummen.ueberfaellig,
    naechste_faelligkeit: naechsteFaelligkeit
      ? {
          bezeichnung: naechsteFaelligkeit.bezeichnung,
          betrag_eur: round2(naechsteFaelligkeit.betrag),
          datum: `${naechsteFaelligkeit.datum.getFullYear()}-${String(naechsteFaelligkeit.datum.getMonth() + 1).padStart(2, '0')}-${String(naechsteFaelligkeit.datum.getDate()).padStart(2, '0')}`,
        }
      : null,
  };
}
