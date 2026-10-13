// Robustheit der DB-Verbindungen im Sync (Review-Befunde 1–3). NUR gegen eine lokale Testkopie + mock-hero.
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/t HERO_API_URL=http://127.0.0.1:4599 \
//   node tests/sync/robustheit.test.mjs [laeufe=8]
// Fehler werden im Prozess injiziert (pool.connect / COMMIT), echte Datenbank, echte Trigger.
process.env.SYNC_LEASE_SECONDS = '4'; // kurze Sperre: Ablauf nach kontrolliertem Fehler testbar
process.env.HERO_API_TOKEN ??= 'test-token-kein-echter';
const DB = process.env.DATABASE_URL ?? '';
if (!DB || /railway|rlwy/.test(DB)) throw new Error('Nur lokale Testdatenbank erlaubt');

const { pool } = await import('../../src/db/pool.js');
const { runArea } = await import('../../src/sync/area.js');
const { runSync } = await import('../../src/sync/index.js');
const { syncWageGroups } = await import('../../src/sync/wageGroups.js');
const { syncProjects } = await import('../../src/sync/projects.js');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x !== '' ? `  [${x}]` : ''}`); };
const one = async (sql, p) => Object.values((await pool.query(sql, p)).rows[0] ?? {})[0];
const versions = async () => Number(await one(`SELECT count(*) FROM ds.record_versions`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fetch(`${process.env.HERO_API_URL}/__control`, { method: 'POST', body: '{}' });

// ---- Fehlerinjektion -------------------------------------------------------------------------------
const faults = { failConnects: 0, connectFailed: 0, commitLost: 0, commitsLost: 0 };
const origConnect = pool.connect.bind(pool);
pool.connect = function (cb) {
  if (typeof cb === 'function') return origConnect(cb); // pool.query nutzt die Callback-Form → unveraendert
  return (async () => {
    if (faults.failConnects > 0) {
      faults.failConnects--; faults.connectFailed++;
      const e = new Error('connect ECONNREFUSED 127.0.0.1 (Testfehler)'); e.code = 'ECONNREFUSED'; throw e;
    }
    const c = await origConnect();
    if (!c.__testPatched) {
      const q = c.query.bind(c);
      c.query = async (text, ...rest) => {
        if (text === 'COMMIT' && faults.commitLost > 0) {
          faults.commitLost--;
          await q(text, ...rest); // COMMIT wird WIRKLICH ausgefuehrt …
          faults.commitsLost++;
          const e = new Error('Connection terminated unexpectedly (Testfehler: Bestaetigung nach COMMIT verloren)');
          e.code = '08006';
          throw e;                // … aber die Bestaetigung geht verloren
        }
        return q(text, ...rest);
      };
      c.__testPatched = true;
    }
    return c;
  })();
};
const newRun = async () => Number(await one(`INSERT INTO sync_runs (status) VALUES ('running') RETURNING id`));
const closeRun = (id, st) => pool.query(`UPDATE sync_runs SET status = $2, finished_at = now() WHERE id = $1`, [id, st]);

// ---- 1. Listener-Bereinigung -----------------------------------------------------------------------
const N = Number(process.argv[2] ?? 8);
const errListeners = () => (pool._clients ?? []).map((c) => c.listenerCount('error'));
const counts = [];
for (let i = 0; i < N; i++) {
  await runSync('hourly');
  const l = errListeners();
  counts.push(Math.max(0, ...l));
}
const st = (await pool.query(`SELECT status FROM sync_runs ORDER BY id DESC LIMIT $1`, [N])).rows;
console.log(`Listener je Pool-Verbindung (max) nach Lauf 1..${N}: ${counts.join(',')}; Pool-Verbindungen: ${pool.totalCount}`);
ok(st.every((r) => r.status === 'success'), `${N} aufeinanderfolgende Laeufe im selben Prozess: success`);
ok(counts.every((c) => c === counts[0]) && counts[0] <= 1, 'Listener-Anzahl waechst nicht (max. 1 = Pool-Handler fuer ruhende Verbindung)', counts.join(','));
ok(pool.totalCount <= 5, 'Pool-Groesse begrenzt', pool.totalCount);

// ---- 2a. Verbindungsaufbau scheitert einmal (begin → withConn, Seite → writeTx) ----------------------
{
  const runId = await newRun();
  faults.failConnects = 1; faults.connectFailed = 0;
  const r = await runArea({ runId, area: 'wage_groups', mode: 'manual' }, async (run) => {
    run.dropClient();                 // naechster Zugriff braucht eine neue Verbindung …
    faults.failConnects = 1;          // … deren erster Aufbau scheitert (in writeTx)
    return syncWageGroups(run);
  });
  await closeRun(runId, r.status === 'success' ? 'success' : 'error');
  ok(faults.connectFailed === 2, '2a: zwei Verbindungsaufbauten gescheitert (begin + Schreibseite)', faults.connectFailed);
  ok(r.status === 'success' && r.vollstaendig, '2a: Bereich trotzdem success + vollstaendig', `${r.status}/${r.vollstaendig}`);
  ok((r.neue_verbindungen ?? 0) >= 1, '2a: Wiederholung protokolliert', r.neue_verbindungen);
  ok(!r.freigabe_fehler, '2a: Sperre freigegeben');
}

// ---- 2b. Verbindungsaufbau scheitert dauerhaft → kontrolliertes Ende ----------------------------------
{
  const runId = await newRun();
  let r;
  try {
    r = await runArea({ runId, area: 'wage_groups', mode: 'manual' }, async (run) => {
      run.dropClient();
      faults.failConnects = 1e9;      // ab jetzt keine Verbindung mehr
      return syncWageGroups(run);
    });
  } catch (e) {
    r = { status: 'AUSNAHME', fehler: e.message };
  } finally {
    faults.failConnects = 0;
  }
  await closeRun(runId, 'error');
  ok(r.status === 'error', '2b: Bereich endet als error (keine Ausnahme, Prozess laeuft weiter)', `${r.status}: ${(r.fehler ?? '').slice(0, 60)}`);
  ok(Boolean(r.abschluss_fehler) && Boolean(r.freigabe_fehler), '2b: Abschluss und Freigabe ohne Verbindung scheitern kontrolliert (protokolliert)');
  ok(Number(await one(`SELECT count(*) FROM wage_groups WHERE last_seen_run_id = $1`, [runId])) === 0, '2b: nichts geschrieben');
  await sleep(4500);
  const z1 = await one(`SELECT zustand FROM ds.sync_area_state WHERE area = 'wage_groups'`);
  ok(z1 === 'sperre_abgelaufen', '2b: nach Sperrablauf sichtbar als sperre_abgelaufen', z1);
  const runId2 = await newRun();
  const r2 = await runArea({ runId: runId2, area: 'wage_groups', mode: 'manual' }, (run) => syncWageGroups(run));
  await closeRun(runId2, r2.status === 'success' ? 'success' : 'error');
  const alt = await one(`SELECT status FROM ds.sync_area_runs WHERE run_id = $1 AND area = 'wage_groups'`, [runId]);
  ok(r2.status === 'success' && alt === 'abandoned', '2b: Folgelauf uebernimmt, alter Bereichslauf abandoned', `${r2.status}/${alt}`);
  ok((await one(`SELECT zustand FROM ds.sync_area_state WHERE area = 'wage_groups'`)) === 'ok', '2b: Zustand wieder ok');
}

// ---- 3. Unklarer COMMIT-Ausgang: Commit erfolgreich, Bestaetigung verloren, Wiederholung -------------
{
  const v0 = await versions();
  const runId = await newRun();
  faults.commitsLost = 0;
  const r = await runArea({ runId, area: 'projects', mode: 'manual' }, async (run) => {
    faults.commitLost = 1;            // erste Schreibseite: COMMIT wirkt, Bestaetigung geht verloren
    return syncProjects(run);
  });
  await closeRun(runId, r.status === 'success' ? 'success' : 'error');
  const stamped = Number(await one(`SELECT count(*) FROM projects WHERE last_seen_run_id = $1`, [runId]));
  const rf = Number(await one(`SELECT rows_fetched FROM ds.sync_area_runs WHERE run_id = $1 AND area = 'projects'`, [runId]));
  const total = Number(await one(`SELECT count(*) FROM projects WHERE deleted_at IS NULL`));
  console.log(`3: commitsLost=${faults.commitsLost} seiten=${r.seiten} count=${r.count} rows_fetched=${rf} gestempelt=${stamped} Projekte=${total} neue_verbindungen=${r.neue_verbindungen}`);
  ok(faults.commitsLost === 1, '3: ein COMMIT wurde ausgefuehrt, Bestaetigung verloren');
  ok(r.status === 'success' && r.vollstaendig, '3: Bereich nach Wiederholung success + vollstaendig');
  ok(rf === stamped && r.count === rf, '3: rows_fetched = gestempelt = gezaehlte Schluessel (keine Doppelzaehlung)', `${rf}/${stamped}/${r.count}`);
  ok((await versions()) === v0, '3: keine zusaetzlichen Inhaltsversionen', `${v0} → ${await versions()}`);
  ok(r.loeschabgleich?.markiert === 0 && (r.loeschabgleich?.kandidaten ?? -1) === total - stamped, '3: Loesch-Probelauf plausibel, 0 markiert', r.loeschabgleich?.kandidaten ?? r.loeschabgleich?.abgelehnt);
  ok(!r.freigabe_fehler, '3: Sperre freigegeben');
}

// Listener nach allen Fehlerfaellen
const after = Math.max(0, ...errListeners());
ok(after <= 1, 'nach allen Fehlerfaellen: keine zusaetzlichen Listener auf Pool-Verbindungen', after);
ok(Number(await one(`SELECT count(*) FROM ds.sync_area_leases WHERE lease_token IS NOT NULL`)) === 0, 'alle Sperren frei');

console.log(`ERGEBNIS robustheit: ${pass} bestanden, ${fail} fehlgeschlagen`);
await pool.end();
process.exit(fail ? 1 : 0);
