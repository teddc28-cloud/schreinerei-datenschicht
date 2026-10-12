import { pool } from '../../db/pool.js';
import { PRODUKTIVE_KATEGORIEN } from './produktiveKategorien.js';

/**
 * Soll/Ist-Stunden je aktivem Projekt.
 * Soll: letzte Auftragsbestaetigung des Projekts, ersatzweise Angebot -> data.items[type="table"].totalTime (Minuten).
 * Ist: tracking_times in produktiven Kategorien, gesamte Projektlaufzeit (kein Monatsfilter).
 * Gemeinsam genutzt von der Projektampeln-Kachel (5.5, nur "In Umsetzung") und der
 * Werkstatt-Kachel (Aggregat, "In Umsetzung" + "Kundenrechnung" - Hero dreht den Status
 * offenbar schon auf "Kundenrechnung", sobald die erste Teilrechnung raus ist, auch wenn
 * noch gearbeitet wird - die meisten echten Ist-Stunden haengen an dem Status, nicht an
 * "In Umsetzung". Verifiziert: mit beiden Status ergibt die Summenquote 127.4%, passend
 * zum bekannten Referenzwert 128% Stand 09/2026).
 * Bei mehreren Entwuerfen gleichen Typs und Datums entscheidet die hoechste Entwurfs-ID (juengster Stand) –
 * vorher war die Auswahl bei Gleichstand zufaellig (physische Zeilenreihenfolge).
 */
export async function getAktiveProjekteStunden(statusNamen = ['In Umsetzung']) {
  const { rows: laufendeProjekte } = await pool.query(
    `SELECT id, display_id, name FROM projects WHERE status_name = ANY($1) AND deleted_at IS NULL`,
    [statusNamen]
  );
  if (laufendeProjekte.length === 0) {
    return { anzahl_laufend: 0, projekte: [] };
  }
  const projectIds = laufendeProjekte.map((p) => p.id);

  const { rows: drafts } = await pool.query(
    `SELECT DISTINCT ON (project_match_id) project_match_id, data
     FROM document_drafts
     WHERE project_match_id = ANY($1) AND type IN ('confirmation', 'offer') AND deleted_at IS NULL
     ORDER BY project_match_id, (type = 'confirmation') DESC, (data->>'date') DESC NULLS LAST, id DESC`,
    [projectIds]
  );
  const draftByProject = new Map(drafts.map((d) => [String(d.project_match_id), d.data]));

  const { rows: stundenRows } = await pool.query(
    `SELECT project_match_id, COALESCE(SUM(EXTRACT(EPOCH FROM ("end" - start))), 0) / 3600 AS stunden
     FROM tracking_times
     WHERE project_match_id = ANY($1) AND tracking_times_category_id = ANY($2) AND "end" IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY project_match_id`,
    [projectIds, PRODUKTIVE_KATEGORIEN]
  );
  const istStundenByProject = new Map(stundenRows.map((r) => [String(r.project_match_id), Number(r.stunden)]));

  const round2 = (n) => Math.round(n * 100) / 100;
  const projekte = [];

  for (const p of laufendeProjekte) {
    const draftData = draftByProject.get(String(p.id));
    if (!draftData) continue; // kein Angebot/Auftragsbestaetigung vorhanden -> keine Soll-Basis

    const tableItems = (draftData.items ?? []).filter((i) => i.type === 'table');
    const sollMinuten = tableItems.reduce((sum, i) => sum + (Number(i.totalTime) || 0), 0);
    if (sollMinuten <= 0) continue; // Soll-Zeit 0 -> nicht sinnvoll auswertbar

    const sollStunden = sollMinuten / 60;
    const istStunden = istStundenByProject.get(String(p.id)) ?? 0;
    const prozent = (istStunden / sollStunden) * 100;

    projekte.push({
      id: p.id,
      display_id: p.display_id,
      name: p.name,
      soll_stunden: round2(sollStunden),
      ist_stunden: round2(istStunden),
      prozent: round2(prozent),
      abweichung_stunden: round2(istStunden - sollStunden),
    });
  }

  return { anzahl_laufend: laufendeProjekte.length, projekte };
}
