import { pool } from '../../db/pool.js';
import { PRODUKTIVE_KATEGORIEN } from './produktiveKategorien.js';

/**
 * Soll/Ist-Stunden je aktivem Projekt ("In Umsetzung", per Nutzer-Entscheidung).
 * Soll: letzte Auftragsbestaetigung des Projekts, ersatzweise Angebot -> data.items[type="table"].totalTime (Minuten).
 * Ist: tracking_times in produktiven Kategorien, gesamte Projektlaufzeit (kein Monatsfilter).
 * Gemeinsam genutzt von der Projektampeln-Kachel (5.5) und der Werkstatt-Kachel.
 */
export async function getAktiveProjekteStunden() {
  const { rows: laufendeProjekte } = await pool.query(
    `SELECT id, display_id, name FROM projects WHERE status_name = 'In Umsetzung'`
  );
  if (laufendeProjekte.length === 0) {
    return { anzahl_laufend: 0, projekte: [] };
  }
  const projectIds = laufendeProjekte.map((p) => p.id);

  const { rows: drafts } = await pool.query(
    `SELECT DISTINCT ON (project_match_id) project_match_id, data
     FROM document_drafts
     WHERE project_match_id = ANY($1) AND type IN ('confirmation', 'offer')
     ORDER BY project_match_id, (type = 'confirmation') DESC, (data->>'date') DESC NULLS LAST`,
    [projectIds]
  );
  const draftByProject = new Map(drafts.map((d) => [String(d.project_match_id), d.data]));

  const { rows: stundenRows } = await pool.query(
    `SELECT project_match_id, COALESCE(SUM(EXTRACT(EPOCH FROM ("end" - start))), 0) / 3600 AS stunden
     FROM tracking_times
     WHERE project_match_id = ANY($1) AND tracking_times_category_id = ANY($2) AND "end" IS NOT NULL
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
