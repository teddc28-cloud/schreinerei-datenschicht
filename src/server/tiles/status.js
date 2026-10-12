import { pool } from '../../db/pool.js';
import { getParameterNumber } from '../../db/parameters.js';

// Bereichszustaende aus ds.sync_area_state (Migration 010), die als Problem gelten.
const PROBLEM_ZUSTAENDE = ['veraltet', 'noch_nie_erfolgreich', 'fehler_seit_letztem_erfolg', 'sperre_abgelaufen', 'noch_nie_synchronisiert'];

export async function getSyncStatus() {
  const [{ rows }, { rows: bereiche }, warnschwelleStunden] = await Promise.all([
    pool.query(
      `SELECT finished_at, status FROM sync_runs
       WHERE status = 'success'
       ORDER BY finished_at DESC LIMIT 1`
    ),
    pool.query(
      `SELECT area, zustand FROM ds.sync_area_state
       WHERE enabled AND zustand = ANY ($1)
       ORDER BY area`,
      [PROBLEM_ZUSTAENDE]
    ),
    getParameterNumber('sync_warnschwelle', 3),
  ]);

  const bereicheMitProblem = bereiche.map((b) => ({ bereich: b.area, zustand: b.zustand }));

  if (rows.length === 0) {
    return { last_success: null, red: true, warnschwelle_stunden: warnschwelleStunden, bereiche_mit_problem: bereicheMitProblem };
  }

  const lastSuccess = rows[0].finished_at;
  const ageHours = (Date.now() - new Date(lastSuccess).getTime()) / 3600000;

  return {
    last_success: lastSuccess,
    red: ageHours > warnschwelleStunden || bereicheMitProblem.length > 0,
    warnschwelle_stunden: warnschwelleStunden,
    bereiche_mit_problem: bereicheMitProblem,
  };
}
