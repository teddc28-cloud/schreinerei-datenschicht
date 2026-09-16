import { dbQuery } from '../db/pool.js';
import { heroQueryAllPages } from '../hero/client.js';
import { PROJECT_MATCHES_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

export async function syncProjects() {
  const rows = await heroQueryAllPages(PROJECT_MATCHES_QUERY, 'project_matches');

  for (const p of rows) {
    await dbQuery(
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

  return { count: rows.length };
}
