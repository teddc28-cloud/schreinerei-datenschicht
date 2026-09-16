import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';

export async function getSyncStatus() {
  const { rows } = await pool.query(
    `SELECT finished_at, status FROM sync_runs
     WHERE status = 'success'
     ORDER BY finished_at DESC LIMIT 1`
  );
  const warnschwelleStunden = await getParameterNumber('sync_warnschwelle', 3);

  if (rows.length === 0) {
    return { last_success: null, red: true, warnschwelle_stunden: warnschwelleStunden };
  }

  const lastSuccess = rows[0].finished_at;
  const ageHours = (Date.now() - new Date(lastSuccess).getTime()) / 3600000;

  return {
    last_success: lastSuccess,
    red: ageHours > warnschwelleStunden,
    warnschwelle_stunden: warnschwelleStunden,
  };
}
