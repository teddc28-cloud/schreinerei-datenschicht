import '../tz.js'; // zuerst: Zeitzone fuer alle Datumsberechnungen
import { pathToFileURL } from 'node:url';
import { pool, dbQuery } from '../db/pool.js';
import { runArea } from './area.js';
import { syncProjects } from './projects.js';
import { syncDocumentAreas } from './documents.js';
import { syncWageGroups } from './wageGroups.js';
import { syncReceipts } from './receipts.js';
import { syncTrackingTimes, trackingWindow, MONTHS_BACK } from './trackingTimes.js';
import { shortError } from '../utils/errors.js';

/** Der Sync setzt die Datenschicht-Migrationen 010–030 voraus (Bereichslaeufe, Sperren, Trigger). */
async function assertMigrations() {
  const { rows } = await dbQuery(
    `SELECT to_regclass('ds.migrations') IS NOT NULL AS ok`
  );
  if (!rows[0].ok) throw new Error('Datenschicht-Migrationen fehlen (Schema ds) – Sync abgebrochen, erst 010–060 anwenden');
  const { rows: m } = await dbQuery(`SELECT array_agg(name ORDER BY name) AS n FROM ds.migrations`);
  const have = new Set(m[0].n ?? []);
  const missing = ['010', '020', '030'].filter((x) => !have.has(x));
  if (missing.length) throw new Error(`Datenschicht-Migrationen fehlen: ${missing.join(', ')} – Sync abgebrochen`);
}

/**
 * mode:
 *   'hourly'  - laufender Sync (Standard)
 *   'nightly' - zusaetzlicher Abgleich der letzten 3 Monate Zeitbuchungen
 *   'initial' - Erstlauf, zwei volle Jahre Historie
 *
 * Jeder Bereich laeuft isoliert (eigene Sperre, eigene Verbindung, eigener Abschluss).
 * Ein Fehler in einem Bereich bricht die anderen nicht ab.
 * sync_runs.status: 'success' wenn kein Bereich fehlschlug (gesperrte Bereiche gelten als uebersprungen),
 * sonst 'error' mit kurzer Liste der betroffenen Bereiche.
 */
export async function runSync(mode = 'hourly', { now = new Date() } = {}) {
  const { rows } = await dbQuery(`INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`);
  const runId = Number(rows[0].id);
  const details = { modus: mode };

  try {
    await assertMigrations();

    details.projects = await runArea({ runId, area: 'projects', mode }, (run) => syncProjects(run));
    details.wage_groups = await runArea({ runId, area: 'wage_groups', mode }, (run) => syncWageGroups(run));
    Object.assign(details, await syncDocumentAreas({ runId, mode }));
    details.receipts = await runArea({ runId, area: 'receipts', mode }, (run) => syncReceipts(run));

    const monthsBack = MONTHS_BACK[mode] ?? MONTHS_BACK.hourly;
    const { windowFrom, windowTo, slices } = trackingWindow(monthsBack, now);
    details.tracking_times = await runArea(
      { runId, area: 'tracking_times', mode, windowFrom, windowTo },
      (run) => syncTrackingTimes(run, { slices })
    );
    details.tracking_times.fenster = { von: windowFrom, bis: windowTo };

    const areas = ['projects', 'wage_groups', 'documents', 'document_drafts', 'receipts', 'tracking_times'];
    const failed = areas.filter((a) => details[a]?.status === 'error');
    const skipped = areas.filter((a) => ['gesperrt', 'uebersprungen'].includes(details[a]?.status));
    if (failed.length) {
      const msg = `Bereiche mit Fehler: ${failed.map((a) => `${a} (${details[a].fehler ?? '?'})`).join('; ')}`;
      await dbQuery(
        `UPDATE sync_runs SET status = 'error', finished_at = now(), error_message = $2, details = $3 WHERE id = $1`,
        [runId, shortError(msg, 500), details]
      );
      console.error(`Sync-Lauf ${runId} (${mode}) mit Fehlern:`, shortError(msg, 500));
    } else {
      await dbQuery(`UPDATE sync_runs SET status = 'success', finished_at = now(), details = $2 WHERE id = $1`, [runId, details]);
      console.log(`Sync-Lauf ${runId} (${mode}) erfolgreich${skipped.length ? ` (uebersprungen, gesperrt: ${skipped.join(', ')})` : ''}:`,
        Object.fromEntries(areas.map((a) => [a, details[a]?.count ?? details[a]?.status])));
    }
  } catch (err) {
    await dbQuery(
      `UPDATE sync_runs SET status = 'error', finished_at = now(), error_message = $2, details = $3 WHERE id = $1`,
      [runId, shortError(err, 500), details]
    );
    console.error(`Sync-Lauf ${runId} (${mode}) fehlgeschlagen:`, shortError(err, 500));
    // bewusst kein Rethrow / keine Mail - Fehler landet im Statusfeld (sync_runs), siehe Pflichtenheft Abschnitt 4
  }
  return runId;
}

// Direktaufruf: node src/sync/index.js [hourly|nightly|initial]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'hourly';
  runSync(mode).then(() => pool.end());
}
