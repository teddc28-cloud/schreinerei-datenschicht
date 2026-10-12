import { heroPages } from '../hero/client.js';
import { PROJECT_MATCHES_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

/**
 * Bereich projects. Hinweis (Analyse 12.10.2026): project_matches liefert ohne type-Argument nur
 * nicht geloeschte Projekte bestimmter Projekttypen. Archivierte/geloeschte (is_deleted) und Projekte
 * des Typs id 1 fehlen daher – sichtbar in ds.v_missing_projects. Abrufumfang bewusst unveraendert
 * (Erweiterung auf type: "all" aendert Dashboard-Mengen → eigene Entscheidung, siehe docs/V3-SYNC-UMSTELLUNG.md).
 */
export async function syncProjects(run) {
  for await (const { rows, last } of heroPages(PROJECT_MATCHES_QUERY, (d) => d.project_matches, { pageSize: 500 })) {
    await run.writeTx(async (c) => {
      for (const p of rows) {
        await c.query(
          `INSERT INTO projects (id, display_id, name, volume, status_id, status_name, customer, created, synced_at, raw_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
           ON CONFLICT (id) DO UPDATE SET
             display_id = EXCLUDED.display_id,
             name = EXCLUDED.name,
             volume = EXCLUDED.volume,
             status_id = EXCLUDED.status_id,
             status_name = EXCLUDED.status_name,
             customer = EXCLUDED.customer,
             synced_at = now(),
             raw_json = EXCLUDED.raw_json`,
          [
            p.id,
            p.display_id,
            p.name,
            p.volume,
            p.current_project_match_status_id,
            p.current_project_match_status?.name ?? null,
            p.customer ? safeJsonStringify(p.customer) : null,
            p.created,
            safeJsonStringify(p),
          ]
        );
      }
      return rows.map((p) => p.id);
    });
    if (last) return { complete: true };
  }
  return { complete: true };
}
