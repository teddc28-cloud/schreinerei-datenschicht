import { heroQuery } from '../hero/client.js';
import { WAGE_GROUPS_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

const PAGE = 200;

export async function syncWageGroups(run) {
  // Kleine, stabile Liste (~10 Zeilen) - eine Seite reicht. Vollstaendig nur, wenn die Seite nicht voll ist.
  const data = await heroQuery(WAGE_GROUPS_QUERY(PAGE, 0));
  const rows = data.WageGroup_WageGroups.edges.map((e) => e.node);

  await run.writeTx(async (c) => {
    for (const w of rows) {
      await c.query(
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
    return rows.map((w) => w.id);
  });
  return { complete: rows.length < PAGE };
}
