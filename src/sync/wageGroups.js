import { dbQuery } from '../db/pool.js';
import { heroQuery } from '../hero/client.js';
import { WAGE_GROUPS_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

export async function syncWageGroups() {
  // Kleine, stabile Liste (~10 Zeilen) - eine Seite reicht.
  const data = await heroQuery(WAGE_GROUPS_QUERY(200, 0));
  const rows = data.WageGroup_WageGroups.edges.map((e) => e.node);

  for (const w of rows) {
    await dbQuery(
      `INSERT INTO wage_groups (id, name, wage_cost_price, wage_per_hour, synced_at, raw_json)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         wage_cost_price = EXCLUDED.wage_cost_price,
         wage_per_hour = EXCLUDED.wage_per_hour,
         synced_at = now(),
         raw_json = EXCLUDED.raw_json`,
      [w.id, w.name, w.wageCostPrice, w.wagePerHour, safeJsonStringify(w)]
    );
  }

  return { count: rows.length };
}
