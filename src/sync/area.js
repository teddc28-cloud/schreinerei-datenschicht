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
const CONN_RETRIES = Number(process.env.SYNC_CONN_RETRIES ?? 2); // Wiederholungen je Operation nach Verbindungsabbruch

// Verbindungsfehler: Verbindung ist verloren, Operation kann mit neuer Verbindung wiederholt werden.
// 57P01 admin_shutdown (pg_terminate_backend), 57P02/57P03, Klasse 08 = connection exception.
const CONN_ERROR_CODES = /^(57P0[123]|08\d{3})$/;
export function isConnectionError(err) {
  return Boolean(err) && (
    CONN_ERROR_CODES.test(err.code ?? '') ||
    isTransient(err) ||
    /not queryable|Connection terminated|terminating connection|server closed the connection|ECONNREFUSED|EPIPE|socket hang up|timeout exceeded when trying to connect/i.test(err.message ?? '')
  );
}
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
    this.broken = false;
    this.reconnects = 0;
  }

  /**
   * Feste Verbindung holen. Jede ausgeliehene Verbindung bekommt einen EIGENEN error-Handler: Der Pool-Handler
   * greift nur fuer ruhende Pool-Verbindungen. Ohne Handler beendet ein Abbruch waehrend der HERO-Abfrage
   * (Verbindung ausgeliehen, aber gerade unbenutzt) den ganzen Node-Prozess.
   * Der Handler wird gespeichert und bei der Rueckgabe in den Pool wieder entfernt (keine wachsende Listener-Zahl
   * auf wiederverwendeten Pool-Verbindungen). Verbindungsfehler beim Aufbau wirft connect() weiter; die
   * Wiederholung uebernehmen withConn()/writeTx().
   */
  async connect() {
    if (this.client && !this.broken) return;
    if (this.client) {
      this.dropClient(true); // defekte Verbindung verwerfen, nicht in den Pool zurueckgeben
      this.reconnects += 1;
    }
    const c = await pool.connect();
    const onError = (err) => {
      if (this.client === c) {
        this.broken = true;
        this.lastConnError = shortError(err);
      }
    };
    c.on('error', onError);
    this.client = c;
    this.onClientError = onError;
    this.broken = false;
    try {
      await c.query(`SELECT set_config('application_name', $1, false)`, [`ds-sync:${this.area}`]);
    } catch (err) {
      this.broken = true;
      if (!isConnectionError(err)) {
        this.dropClient(true);
        throw err;
      }
      throw err; // Verbindungsfehler: Aufrufer wiederholt mit neuer Verbindung
    }
  }

  dropClient(broken = false) {
    if (!this.client) return;
    const c = this.client;
    const destroy = broken || this.broken;
    this.client = null;
    this.broken = false;
    if (this.onClientError) {
      c.removeListener('error', this.onClientError);
      this.onClientError = null;
    }
    // Eine verworfene Verbindung wird vom Pool beendet; Fehler beim Beenden duerfen den Prozess nicht stoppen.
    // Der Pool verwendet sie nicht wieder, der Listener waechst also auf keiner Pool-Verbindung.
    if (destroy) c.once('error', () => {});
    try { c.release(destroy ? true : undefined); } catch { /* ignoriert */ }
  }

  async retryPause(attempt) {
    await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 2000)));
  }

  /**
   * Fuehrt eine Operation auf der festen Verbindung aus. Verbindungsaufbau UND Operation liegen in derselben
   * begrenzten Fehlerbehandlung: Bei Verbindungsfehler wird die Verbindung verworfen und mit neuer Verbindung
   * wiederholt (max. CONN_RETRIES). Die Bereichssperre haengt nicht an der Verbindung (Zeile in
   * ds.sync_area_leases) und bleibt dabei gueltig.
   */
  async withConn(op) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.connect();
        return await op(this.client);
      } catch (err) {
        if ((isConnectionError(err) || this.broken) && attempt < CONN_RETRIES) {
          this.dropClient(true);
          this.reconnects += 1;
          await this.retryPause(attempt);
          continue;
        }
        if (isConnectionError(err) || this.broken) this.dropClient(true);
        throw err;
      }
    }
  }

  async begin() {
    try {
      const { rows } = await this.withConn((c) => c.query(
        `SELECT area_run_id, lease_token
           FROM ds.begin_area_run($1, $2, $3, $4::date, $5::date, $6, make_interval(secs => $7))`,
        [this.runId, this.area, this.mode, this.windowFrom, this.windowTo, HOLDER, LEASE_SECONDS]
      ));
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
    await this.withConn((c) => c.query(`SELECT ds.renew_area_lease($1, $2, make_interval(secs => $3))`, [
      this.areaRunId,
      this.token,
      LEASE_SECONDS,
    ]));
    this.renewAt = Date.now() + (LEASE_SECONDS * 1000) / 2;
  }

  /**
   * Kurze Schreibtransaktion mit Lauf-ID. `fn(client)` liefert die geschriebenen Schluessel zurueck.
   * Bei abgerissener Verbindung (auch waehrend der HERO-Abfrage davor) Wiederholung mit neuer Verbindung,
   * max. CONN_RETRIES; die Upserts sind idempotent. Danach Fehler → Bereich wird als error abgeschlossen.
   */
  async writeTx(fn) {
    for (let attempt = 0; ; attempt++) {
      let c = null;
      try {
        await this.ensureLease();
        await this.connect();
        c = this.client;
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ds.run_id', $1, true)`, [String(this.runId)]);
        const keys = await fn(c);
        await c.query('COMMIT');
        for (const k of keys ?? []) this.keys.add(String(k));
        this.pages += 1;
        return;
      } catch (err) {
        if (!(isConnectionError(err) || this.broken)) {
          if (c) try { await c.query('ROLLBACK'); } catch { /* ignoriert */ }
          throw err;
        }
        // Ausgang UNKLAR: Abbruch vor dem COMMIT = Rollback; Abbruch nach gesendetem COMMIT kann bereits
        // committet sein (Bestaetigung verloren). Die Wiederholung ist in beiden Faellen sicher: Upserts sind
        // idempotent, die Lauf-ID ist dieselbe (gleicher Stempel), Versionen entstehen nur bei Inhaltsaenderung,
        // und rows_fetched zaehlt eindeutige Schluessel (Set). Getestet: tests/sync/robustheit.test.mjs.
        this.dropClient(true);
        if (attempt < CONN_RETRIES) {
          this.reconnects += 1;
          await this.retryPause(attempt);
          continue;
        }
        throw err;
      }
    }
  }

  async finish(status, complete, errorText = null) {
    const args = [this.areaRunId, this.token, status, complete, this.keys.size, errorText ? shortError(errorText, 500) : null];
    try {
      await this.withConn((c) => c.query(`SELECT ds.finish_area_run($1, $2, $3, $4, $5, $6)`, args));
    } catch (err) {
      // Wiederholung nach Verbindungsabbruch, obwohl der erste Abschluss schon committet war: als erledigt werten,
      // wenn genau dieser Abschluss in der DB steht.
      if (!/bereits abgeschlossen/.test(err.message ?? '')) throw err;
      const { rows } = await this.withConn((c) => c.query(`SELECT status, complete FROM ds.sync_area_runs WHERE id = $1`, [this.areaRunId]));
      if (rows[0]?.status !== status || rows[0]?.complete !== (status === 'success' && Boolean(complete))) throw err;
    }
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
      await c.query('BEGIN'); // keine Wiederholung: der Probelauf ist optional, Fehler werden nur protokolliert
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
        await this.withConn((c) => c.query(`SELECT ds.release_area_lease($1, $2)`, [this.areaRunId, this.token]));
      }
      return null;
    } catch (err) {
      // Wiederholte Freigabe nach verlorener Bestaetigung: Sperre ist bereits frei → kein Fehler
      if (/nicht \(mehr\) gehalten/.test(err.message ?? '')) {
        try {
          const { rows } = await this.withConn((c) => c.query(
            `SELECT l.lease_token IS NULL AS frei FROM ds.sync_area_leases l WHERE l.area = $1`, [this.area]));
          if (rows[0]?.frei && this.reconnects > 0) return null;
        } catch { /* Originalfehler melden */ }
      }
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
  if (run.reconnects) result.neue_verbindungen = run.reconnects; // nach Verbindungsabbruch
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
