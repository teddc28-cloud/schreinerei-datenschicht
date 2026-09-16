import { pathToFileURL } from 'node:url';
import { pool, dbQuery } from '../db/pool.js';
import { syncProjects } from './projects.js';
import { syncDocuments } from './documents.js';
import { syncWageGroups } from './wageGroups.js';
import { syncReceipts } from './receipts.js';
import { syncTrackingTimes } from './trackingTimes.js';

/**
 * mode:
 *   'hourly'  - laufender Sync (Standard)
 *   'nightly' - zusaetzlicher Vollabgleich der letzten 90 Tage
 *   'initial' - Erstlauf, zwei volle Jahre Historie
 */
export async function runSync(mode = 'hourly') {
  const { rows } = await dbQuery(
    `INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`
  );
  const runId = rows[0].id;
  const details = {};

  try {
    details.projects = await syncProjects();
    details.wage_groups = await syncWageGroups();
    details.documents = await syncDocuments();
    details.receipts = await syncReceipts();

    const monthsBack = mode === 'initial' ? 25 : mode === 'nightly' ? 3 : 1;
    details.tracking_times = await syncTrackingTimes({ monthsBack });

    await dbQuery(
      `UPDATE sync_runs SET status = 'success', finished_at = now(), details = $2 WHERE id = $1`,
      [runId, details]
    );
    console.log(`Sync-Lauf ${runId} (${mode}) erfolgreich:`, details);
  } catch (err) {
    await dbQuery(
      `UPDATE sync_runs SET status = 'error', finished_at = now(), error_message = $2, details = $3 WHERE id = $1`,
      [runId, String(err?.message ?? err), details]
    );
    console.error(`Sync-Lauf ${runId} (${mode}) fehlgeschlagen:`, err);
    // bewusst kein Rethrow / keine Mail - Fehler landet nur im Statusfeld (sync_runs), siehe Pflichtenheft Abschnitt 4
  }
}

// Direktaufruf: node src/sync/index.js [hourly|nightly|initial]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'hourly';
  runSync(mode).then(() => pool.end());
}
