import os from 'node:os';
import { pool, isTransient } from '../db/pool.js';
import { shortError } from '../utils/errors.js';

/**
 * Bereichslauf nach Datenschicht-Migration v3 (ds.begin_area_run & Co.).
 *
 * - Feste Datenbankverbindung je Bereichslauf (pool.connect), keine wechselnden Pool-Verbindungen.
 * - Jede Schreibtransaktion setzt ds.run_id per set_config(..., true) – gilt nur in dieser Transaktion.
 *   last_seen_run_id setzt ausschliesslich der Trigger.
 * - Kurze Transaktionen (eine je Abrufseite). Waehrend einer Schreibtransaktion warten Uebernahme und
 *   Loeschabgleich desselben Bereichs (Sperrzeile FOR SHARE).
 * - Sperre wird vor jeder Schreibtransaktion verlaengert, sobald die Haelfte der Laufzeit verbraucht ist.
 * - Loeschmarkierung wird NIE angewendet: nur Probelauf (p_apply = false) mit protokollierten Kandidaten.
 */

const LEASE_SECONDS = Number(process.env.SYNC_LEASE_SECONDS ?? 1800); // 30 min wie in 010
const HOLDER = `${os.hostname()}:${process.pid}`;
const CANDIDATE_LOG_LIMIT = 200;

const AREA_TABLES = {
  projects: { table: 'public.projects', key: 'id' },
  documents: { table: 'public.documents', key: 'id' },
  document_drafts: { table: 'public.document_drafts', key: 'id' },
  receipts: { table: 'public.receipts', key: 'id' },
  wage_groups: { table: 'public.wage_groups', key: 'id' },
  tracking_times: { table: 'public.tracking_times', key: 'uuid' },
};

export class AreaLockedError extends Error {
  constructor(area, detail) {
    super(`Bereich ${area} ist durch einen anderen Lauf gesperrt`);
    this.name = 'AreaLockedError';
    this.area = area;
    this.detail = detail;
  }
}

export class AreaRun {
  constructor({ runId, area, mode, windowFrom = null, windowTo = null }) {
    if (!AREA_TABLES[area]) throw new Error(`Bereich ${area} unbekannt`);
    this.runId = runId;
    this.area = area;
    this.mode = mode;
    this.windowFrom = windowFrom;
    this.windowTo = windowTo;
    this.client = null;
    this.areaRunId = null;
    this.token = null;
    this.renewAt = 0;
    this.keys = new Set(); // tatsaechlich geschriebene Schluessel (rows_fetched = eindeutige Datensaetze)
    this.pages = 0;
    this.finished = false;
  }

  async connect() {
    if (this.client) return;
    this.client = await pool.connect();
  }

  dropClient(broken = false) {
    if (!this.client) return;
    try { this.client.release(broken ? true : undefined); } catch { /* ignoriert */ }
    this.client = null;
  }

  async begin() {
    await this.connect();
    try {
      const { rows } = await this.client.query(
        `SELECT area_run_id, lease_token
           FROM ds.begin_area_run($1, $2, $3, $4::date, $5::date, $6, make_interval(secs => $7))`,
        [this.runId, this.area, this.mode, this.windowFrom, this.windowTo, HOLDER, LEASE_SECONDS]
      );
      this.areaRunId = Number(rows[0].area_run_id);
      this.token = rows[0].lease_token;
      this.renewAt = Date.now() + (LEASE_SECONDS * 1000) / 2;
    } catch (err) {
      if (/ist gesperrt durch Bereichslauf/.test(err.message)) throw new AreaLockedError(this.area, shortError(err));
      throw err;
    }
    return this;
  }

  /** Verlaengert die Sperre, wenn die Haelfte der Laufzeit verbraucht ist. Wirft, wenn sie verloren ist. */
  async ensureLease() {
    if (Date.now() < this.renewAt) return;
    await this.connect();
    await this.client.query(`SELECT ds.renew_area_lease($1, $2, make_interval(secs => $3))`, [
      this.areaRunId,
      this.token,
      LEASE_SECONDS,
    ]);
    this.renewAt = Date.now() + (LEASE_SECONDS * 1000) / 2;
  }

  /**
   * Kurze Schreibtransaktion mit Lauf-ID. `fn(client)` liefert die geschriebenen Schluessel zurueck.
   * Bei abgerissener Verbindung genau ein Wiederholungsversuch mit neuer Verbindung (Upserts sind idempotent).
   */
  async writeTx(fn) {
    for (let attempt = 0; ; attempt++) {
      await this.ensureLease();
      await this.connect();
      const c = this.client;
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ds.run_id', $1, true)`, [String(this.runId)]);
        const keys = await fn(c);
        await c.query('COMMIT');
        for (const k of keys ?? []) this.keys.add(String(k));
        this.pages += 1;
        return;
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch { /* Verbindung evtl. weg */ }
        if (isTransient(err) && attempt === 0) {
          this.dropClient(true);
          continue;
        }
        throw err;
      }
    }
  }

  async finish(status, complete, errorText = null) {
    await this.connect();
    await this.client.query(`SELECT ds.finish_area_run($1, $2, $3, $4, $5, $6)`, [
      this.areaRunId,
      this.token,
      status,
      complete,
      this.keys.size,
      errorText ? shortError(errorText, 500) : null,
    ]);
    this.finished = true;
  }

  /**
   * Probelauf Loeschabgleich (p_apply = false). Kandidaten werden mit Schluessel protokolliert
   * (max. CANDIDATE_LOG_LIMIT), nichts wird markiert. Laeuft unter derselben Sperre/Token.
   */
  async probeDeletion() {
    const { table, key } = AREA_TABLES[this.area];
    let c = null;
    try {
      await this.connect();
      c = this.client;
      await c.query('BEGIN');
      const { rows } = await c.query(
        `SELECT fetched, stamped, active, candidates, marked FROM ds.mark_missing_as_deleted($1, $2, false)`,
        [this.areaRunId, this.token]
      );
      const r = rows[0];
      // Kandidatenliste mit derselben Fensterlogik wie ds.mark_missing_as_deleted (030)
      const windowSql =
        this.windowFrom !== null
          ? `AND start >= (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Berlin')
             AND start <  ($4::date::timestamp AT TIME ZONE 'Europe/Berlin')`
          : '';
      const params = [this.runId, CANDIDATE_LOG_LIMIT];
      if (this.windowFrom !== null) params.push(this.windowFrom, this.windowTo);
      const { rows: cand } = await c.query(
        `SELECT ${key}::text AS k FROM ${table}
          WHERE deleted_at IS NULL AND last_seen_run_id IS DISTINCT FROM $1 ${windowSql}
          ORDER BY 1 LIMIT $2`,
        params
      );
      await c.query('COMMIT');
      return {
        modus: 'probelauf',
        abgerufen: r.fetched,
        gestempelt: r.stamped,
        aktiv: r.active,
        kandidaten: r.candidates,
        markiert: r.marked, // immer 0 (p_apply = false)
        kandidaten_schluessel: cand.map((x) => x.k),
        liste_gekuerzt: r.candidates > cand.length,
      };
    } catch (err) {
      // Probelauf-Fehler (auch Verbindungsabbruch) duerfen weder den Bereich noch den Gesamtlauf abbrechen
      try { if (c) await c.query('ROLLBACK'); } catch { /* ignoriert */ }
      return { modus: 'probelauf', abgelehnt: shortError(err) };
    }
  }

  /** Immer im finally aufrufen. Fehler hier (z. B. Sperre bereits uebernommen) nur protokollieren. */
  async release() {
    try {
      if (this.areaRunId && this.token) {
        await this.connect();
        await this.client.query(`SELECT ds.release_area_lease($1, $2)`, [this.areaRunId, this.token]);
      }
      return null;
    } catch (err) {
      return shortError(err);
    } finally {
      this.dropClient();
    }
  }
}

/** Bereichslauf beginnen. Rueckgabe { run, result } oder { result } bei Sperre/Fehler (Bereich wird uebersprungen). */
export async function startArea(opts) {
  const run = new AreaRun(opts);
  const result = { bereich: opts.area };
  try {
    await run.begin();
  } catch (err) {
    run.dropClient();
    if (err instanceof AreaLockedError) return { result: { ...result, status: 'gesperrt', hinweis: err.detail } };
    return { result: { ...result, status: 'error', fehler: shortError(err) } };
  }
  result.bereichslauf = run.areaRunId;
  return { run, result };
}

/** Bereichslauf abschliessen (Erfolg/Fehler) und bei vollstaendigem Erfolg den Loesch-Probelauf ausfuehren. */
export async function completeArea(run, result, { complete = false, error = null }, { deletionProbe = true } = {}) {
  result.seiten = run.pages;
  result.count = run.keys.size;
  if (error) {
    result.status = 'error';
    result.fehler = shortError(error);
    try {
      await run.finish('error', false, result.fehler);
    } catch (finErr) {
      // z. B. Sperre verloren → Lauf bleibt als abandoned bzw. sperre_abgelaufen sichtbar
      result.abschluss_fehler = shortError(finErr);
    }
    return result;
  }
  try {
    await run.finish('success', Boolean(complete));
  } catch (finErr) {
    result.status = 'error';
    result.fehler = shortError(finErr);
    return result;
  }
  result.status = 'success';
  result.vollstaendig = Boolean(complete);
  if (deletionProbe && complete && process.env.DELETION_PROBE !== 'off') {
    result.loeschabgleich = await run.probeDeletion();
  }
  return result;
}

/** Sperre freigeben (immer, im finally). */
export async function endArea(run, result) {
  const relErr = await run.release();
  if (relErr) result.freigabe_fehler = relErr;
  return result;
}

/**
 * Fuehrt einen Bereich vollstaendig aus: begin → work → finish → (Probe-Loeschabgleich) → release.
 * `work(run)` ruft run.writeTx(...) je Seite auf und liefert { complete: boolean }.
 * Fehler bleiben auf diesen Bereich beschraenkt (Rueckgabe statt throw).
 */
export async function runArea(opts, work, probeOpts) {
  const { run, result } = await startArea(opts);
  if (!run) return result;
  try {
    let outcome;
    try {
      outcome = { complete: (await work(run))?.complete ?? false };
    } catch (err) {
      outcome = { error: err };
    }
    return await completeArea(run, result, outcome, probeOpts);
  } finally {
    await endArea(run, result);
  }
}

export { AREA_TABLES };
