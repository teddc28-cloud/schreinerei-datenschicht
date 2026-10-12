// Sync-Szenarien gegen eine wiederhergestellte DATENBANKKOPIE + kontrollierten HERO-Ersatz (mock-hero.mjs).
// NIE gegen Produktion. Gibt nur Zaehlungen/Status aus, keine Inhalte.
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/t MOCK=http://127.0.0.1:4599 node tests/sync/scenarios.mjs <stufe>
import pg from 'pg';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.DATABASE_URL;
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:4599';
if (!DB || /railway|rlwy|amazonaws|\.net\b/.test(DB)) throw new Error('Nur lokale Testdatenbank erlaubt');

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  [${extra}]` : ''}`); };
const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => Object.values((await q(sql, p))[0] ?? {})[0];

async function control(faults = []) {
  await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ faults }) });
}
async function mockStats() { return (await fetch(`${MOCK}/__stats`)).json(); }

/** Startet einen Sync-Prozess (eigener Node-Prozess = eigene Verbindungen, wie ein zweiter Service). */
function syncProc(mode, env = {}, cwd = ROOT) {
  const t0 = Date.now();
  const child = spawn(process.execPath, ['src/sync/index.js', mode], {
    cwd,
    env: { ...process.env, DATABASE_URL: DB, HERO_API_URL: MOCK, HERO_API_TOKEN: 'test-token-kein-echter', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 })));
  return { child, done };
}
const lastRun = async () => (await q(`SELECT id, status, error_message, details FROM sync_runs ORDER BY id DESC LIMIT 1`))[0];
const areaRuns = async (runId) =>
  Object.fromEntries((await q(`SELECT area, status, complete, rows_fetched FROM ds.sync_area_runs WHERE run_id = $1`, [runId])).map((r) => [r.area, r]));
const versions = async () => Number(await one(`SELECT count(*) FROM ds.record_versions`));
const TABLES = { projects: 'projects', wage_groups: 'wage_groups', documents: 'documents', document_drafts: 'document_drafts', receipts: 'receipts', tracking_times: 'tracking_times' };
const stamped = async (runId) => {
  const o = {};
  for (const [a, t] of Object.entries(TABLES)) o[a] = Number(await one(`SELECT count(*) FROM ${t} WHERE last_seen_run_id = $1`, [runId]));
  return o;
};
const summary = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => TABLES[k]).map(([k, v]) => [k, `${v.status}${v.vollstaendig ? '/vollst' : ''}:${v.count ?? '-'}`]));

const stage = process.argv[2];

if (stage === 'voll') {
  // 1. Vollstaendiger erfolgreicher Sync (Erstlauf-Modus: alle Zeitbuchungen der letzten 25 Monate)
  await control();
  const v0 = await versions();
  const { done } = syncProc('initial');
  const r = await done;
  const run = await lastRun();
  const ar = await areaRuns(run.id);
  console.log(`Laufzeit Vollsync (initial): ${r.ms} ms, sync_runs.status=${run.status}`, JSON.stringify(summary(run.details)));
  ok(run.status === 'success', 'Vollsync: sync_runs.status = success', run.error_message ?? '');
  for (const a of Object.keys(TABLES)) ok(ar[a]?.status === 'success' && ar[a]?.complete, `Bereich ${a}: success + complete`, `${ar[a]?.status}/${ar[a]?.complete}`);
  const st = await stamped(run.id);
  for (const a of Object.keys(TABLES)) ok(st[a] === ar[a]?.rows_fetched, `Bereich ${a}: gestempelt = rows_fetched`, `${st[a]} / ${ar[a]?.rows_fetched}`);
  const tot = { projects: 'projects', documents: 'documents', document_drafts: 'document_drafts', receipts: 'receipts', wage_groups: 'wage_groups' };
  for (const [a, t] of Object.entries(tot)) {
    const total = Number(await one(`SELECT count(*) FROM ${t}`));
    const cand = run.details[a]?.loeschabgleich?.kandidaten ?? NaN;
    ok(st[a] + cand === total, `Bereich ${a}: Zeilen der Kopie = gestempelt + Loeschkandidaten`, `${total} = ${st[a]} + ${cand}`);
  }
  const probes = Object.entries(run.details).filter(([k]) => TABLES[k]).map(([k, v]) => [k, v.loeschabgleich]);
  for (const [a, p] of probes) {
    const consistent = a === 'tracking_times' ? true : p?.kandidaten === p?.aktiv - p?.gestempelt;
    ok(p && p.modus === 'probelauf' && p.markiert === 0 && consistent && (p.kandidaten_schluessel?.length ?? 0) === Math.min(p.kandidaten, 200),
      `Bereich ${a}: Loesch-Probelauf, 0 markiert, Kandidaten protokolliert`, p ? `kandidaten=${p.kandidaten ?? p.abgelehnt}` : 'kein Probelauf');
  }
  ok(Number(await one(`SELECT count(*) FROM (SELECT deleted_at FROM projects WHERE deleted_at IS NOT NULL UNION ALL SELECT deleted_at FROM documents WHERE deleted_at IS NOT NULL UNION ALL SELECT deleted_at FROM tracking_times WHERE deleted_at IS NOT NULL UNION ALL SELECT deleted_at FROM receipts WHERE deleted_at IS NOT NULL) x`)) === 0, 'keine Loeschmarkierung gesetzt');
  const v1 = await versions();
  ok(v1 === v0, 'unveraenderte Quelldaten: keine zusaetzlichen Inhaltsversionen', `${v0} → ${v1}`);
  const leases = Number(await one(`SELECT count(*) FROM ds.sync_area_leases WHERE lease_token IS NOT NULL`));
  ok(leases === 0, 'alle Sperren freigegeben');
  const states = await q(`SELECT area, zustand FROM ds.sync_area_state WHERE enabled ORDER BY area`);
  ok(states.every((s) => s.zustand === 'ok'), 'ds.sync_area_state: alle aktivierten Bereiche ok', states.map((s) => `${s.area}=${s.zustand}`).join(' '));
}

if (stage === 'unveraendert') {
  // 5. Unveraenderte Quelldaten: zwei weitere Laeufe (stuendlich + naechtlich) → keine neuen Versionen
  await control();
  const v0 = await versions();
  const cc0 = await one(`SELECT max(content_changed_at)::text FROM (SELECT content_changed_at FROM documents UNION ALL SELECT content_changed_at FROM projects UNION ALL SELECT content_changed_at FROM tracking_times UNION ALL SELECT content_changed_at FROM receipts) x`);
  const h = await syncProc('hourly').done;
  const run1 = await lastRun();
  const n = await syncProc('nightly').done;
  const run2 = await lastRun();
  const v1 = await versions();
  console.log(`Laufzeit hourly ${h.ms} ms, nightly ${n.ms} ms`);
  ok(run1.status === 'success' && run2.status === 'success', 'hourly + nightly: success');
  ok(v1 === v0, 'keine zusaetzlichen Inhaltsversionen nach 2 Laeufen', `${v0} → ${v1}`);
  const cc1 = await one(`SELECT max(content_changed_at)::text FROM (SELECT content_changed_at FROM documents UNION ALL SELECT content_changed_at FROM projects UNION ALL SELECT content_changed_at FROM tracking_times UNION ALL SELECT content_changed_at FROM receipts) x`);
  ok(cc1 === cc0, 'content_changed_at unveraendert (juengster Wert vorher = nachher)');
  const tw = run1.details.tracking_times.fenster;
  ok(tw && tw.von.endsWith('-01') && tw.von < tw.bis, 'hourly: Zeitfenster laufender + letzter Monat', `${tw?.von}..${tw?.bis}`);
  const stats = await mockStats();
  const tt = Object.entries(stats).filter(([k]) => k.startsWith('tracking_times')).sort();
  const sum = tt.reduce((s, [, n]) => s + n, 0);
  ok(tt.length === 3 && sum === 5, 'Zeitbuchungen: hourly 2 Monatsscheiben + nightly 3 Monatsscheiben (je 1 Seite)', tt.map(([k, n]) => `${k}x${n}`).join(' '));
}

if (stage === 'seitenfehler') {
  // 2. Fehler auf einer spaeteren API-Seite + Bereichsisolation + gekuerzte Fehlertexte
  await control([
    { root: 'customer_documents', page: 3, kind: 'graphql' },
    { root: 'Receipt_Receipts', page: 2, kind: 'html502' },
  ]);
  const v0 = await versions();
  const r = await syncProc('hourly').done;
  const run = await lastRun();
  const ar = await areaRuns(run.id);
  const st = await stamped(run.id);
  console.log(`Laufzeit ${r.ms} ms`, JSON.stringify(summary(run.details)));
  ok(run.status === 'error', 'sync_runs.status = error');
  ok((run.error_message ?? '').length <= 500 && !/<html|<p>/i.test(run.error_message ?? ''), 'Fehlertext gekuerzt, ohne HTML', `${(run.error_message ?? '').length} Zeichen`);
  ok(/documents/.test(run.error_message) && /receipts/.test(run.error_message), 'Fehlertext nennt documents und receipts');
  ok(ar.documents?.status === 'error' && !ar.documents.complete, 'documents: error, nicht vollstaendig');
  ok(ar.document_drafts?.status === 'error' && !ar.document_drafts.complete, 'document_drafts: error, nicht vollstaendig');
  ok(st.documents === 200, 'documents: Seiten 1–2 geschrieben und gestempelt (200)', String(st.documents));
  ok(ar.receipts?.status === 'error' && st.receipts === 200, 'receipts: Seite 1 geschrieben, dann Fehler', `${ar.receipts?.status}/${st.receipts}`);
  for (const a of ['projects', 'wage_groups', 'tracking_times']) ok(ar[a]?.status === 'success' && ar[a]?.complete, `${a}: trotz Fehler in anderen Bereichen success`);
  ok(!run.details.documents.loeschabgleich && !run.details.receipts.loeschabgleich, 'kein Loesch-Probelauf fuer unvollstaendige Bereiche');
  ok(Number(await one(`SELECT count(*) FROM ds.sync_area_leases WHERE lease_token IS NOT NULL`)) === 0, 'alle Sperren freigegeben');
  const z = Object.fromEntries((await q(`SELECT area, zustand FROM ds.sync_area_state`)).map((x) => [x.area, x.zustand]));
  ok(z.documents === 'fehler_seit_letztem_erfolg' && z.receipts === 'fehler_seit_letztem_erfolg', 'Bereichszustand documents/receipts = fehler_seit_letztem_erfolg', `${z.documents}/${z.receipts}`);
  ok((await versions()) === v0, 'keine zusaetzlichen Inhaltsversionen');
  const len = Number(await one(`SELECT max(length(error_message)) FROM ds.sync_area_runs WHERE run_id = $1`, [run.id]));
  ok(len <= 500, 'Bereichs-Fehlertexte <= 500 Zeichen', String(len));
}

if (stage === 'wiederholung') {
  // 3. Wiederholung nach Teilfehler
  await control();
  const v0 = await versions();
  await syncProc('hourly').done;
  const run = await lastRun();
  const ar = await areaRuns(run.id);
  ok(run.status === 'success', 'Wiederholung: success');
  for (const a of Object.keys(TABLES)) ok(ar[a]?.status === 'success' && ar[a]?.complete, `${a}: success + complete`);
  const z = await q(`SELECT area, zustand FROM ds.sync_area_state WHERE enabled`);
  ok(z.every((x) => x.zustand === 'ok'), 'alle Bereiche wieder ok');
  ok(run.details.documents.loeschabgleich?.kandidaten === 0, 'Loesch-Probelauf documents: 0 Kandidaten');
  ok((await versions()) === v0, 'keine zusaetzlichen Inhaltsversionen');
}

if (stage === 'sperre') {
  // 4. Sperrablauf und paralleler Start
  // Lauf A: Sperrdauer 6 s, HERO-Antwort fuer Belegseite 2 verzoegert um 12 s (einmalig) → Sperre laeuft ab.
  // Lauf B: startet, waehrend A die documents-Sperre gueltig haelt → documents/drafts gesperrt, Rest laeuft.
  // Lauf C: startet nach Ablauf → uebernimmt documents, A wird abandoned, A darf danach nicht mehr schreiben.
  await control([{ root: 'customer_documents', page: 2, kind: 'delay', ms: 12000, once: true }]);
  const before = Number(await one(`SELECT max(id) FROM sync_runs`));
  const A = syncProc('hourly', { SYNC_LEASE_SECONDS: '6' });
  let held = null;
  for (let i = 0; i < 200 && !held; i++) {
    await new Promise((r) => setTimeout(r, 100));
    held = (await q(`SELECT l.area_run_id, r.run_id, l.expires_at FROM ds.sync_area_leases l JOIN ds.sync_area_runs r ON r.id = l.area_run_id
                      WHERE l.area = 'documents' AND r.run_id > $1 AND l.expires_at > clock_timestamp()`, [before]))[0];
  }
  ok(Boolean(held), 'A haelt documents-Sperre');
  const runA = Number(held.run_id);
  const B = syncProc('hourly');
  const rb = await B.done;
  const runB = await lastRun();
  console.log(`B Laufzeit ${rb.ms} ms`, JSON.stringify(summary(runB.details)));
  ok(runB.details.documents?.status === 'gesperrt', 'B: documents gesperrt (paralleler Start abgewiesen)', runB.details.documents?.status);
  ok(runB.details.document_drafts?.status === 'uebersprungen', 'B: document_drafts uebersprungen');
  ok(['projects', 'wage_groups', 'receipts', 'tracking_times'].every((a) => runB.details[a]?.status === 'success'), 'B: uebrige Bereiche success');
  ok(runB.status === 'success', 'B: sync_runs success (gesperrt = uebersprungen, kein Fehler)');
  // auf Ablauf der Sperre von A warten
  const exp = new Date((await q(`SELECT expires_at FROM ds.sync_area_leases WHERE area = 'documents'`))[0].expires_at).getTime();
  await new Promise((r) => setTimeout(r, Math.max(0, exp - Date.now()) + 500));
  const zMid = (await q(`SELECT zustand FROM ds.sync_area_state WHERE area = 'documents'`))[0].zustand;
  ok(zMid === 'sperre_abgelaufen', 'nach Ablauf, vor Uebernahme: documents = sperre_abgelaufen', zMid);
  const C = syncProc('hourly');
  const [ra, rc] = await Promise.all([A.done, C.done]);
  const runs = Object.fromEntries((await q(`SELECT id, status, details FROM sync_runs WHERE id > $1`, [before])).map((r) => [Number(r.id), r]));
  const runC = Math.max(...Object.keys(runs).map(Number));
  const arA = await areaRuns(runA), arC = await areaRuns(runC);
  console.log(`A ${ra.ms} ms ${JSON.stringify(summary(runs[runA].details))}`);
  console.log(`C ${rc.ms} ms ${JSON.stringify(summary(runs[runC].details))}`);
  ok(arA.documents.status === 'abandoned', 'A: documents-Bereichslauf durch Uebernahme abandoned', arA.documents.status);
  ok(runs[runA].details.documents.status === 'error' && /Sperre/.test(runs[runA].details.documents.fehler ?? ''), 'A: Schreiben nach Sperrverlust abgelehnt', runs[runA].details.documents.fehler?.slice(0, 90));
  // C stempelt alle Belege neu; massgeblich ist, was A tatsaechlich committet hat (Schluessel erfolgreicher Seiten)
  const cntA = runs[runA].details.documents.count;
  ok(cntA === 100 && runs[runA].details.documents.seiten === 1, 'A: nur Seite 1 (vor Ablauf) committet, nichts nach Ablauf', `committet ${cntA}, Seiten ${runs[runA].details.documents.seiten}`);
  ok(arC.documents.status === 'success' && arC.documents.complete, 'C: documents uebernommen, success + complete');
  ok(runs[runC].status === 'success', 'C: sync_runs success');
  ok(Number(await one(`SELECT count(*) FROM ds.sync_area_leases WHERE lease_token IS NOT NULL`)) === 0, 'alle Sperren freigegeben');
  const z = await q(`SELECT area, zustand FROM ds.sync_area_state WHERE enabled`);
  ok(z.every((x) => x.zustand === 'ok'), 'alle Bereiche ok', z.filter((x) => x.zustand !== 'ok').map((x) => `${x.area}=${x.zustand}`).join(' '));
}

if (stage === 'pflichtstempel') {
  // Pflichtstempel nur in der TESTKOPIE aktivieren und vollstaendigen Ablauf pruefen
  await control();
  await q(`UPDATE ds.sync_areas SET require_run_stamp = true WHERE source_system = 'hero' AND enabled`);
  ok(Number(await one(`SELECT count(*) FROM ds.sync_areas WHERE require_run_stamp`)) === 6, 'require_run_stamp in der Testkopie fuer 6 Bereiche aktiv');
  const v0 = await versions();
  const r = await syncProc('nightly').done;
  const run = await lastRun();
  const ar = await areaRuns(run.id);
  console.log(`Laufzeit nightly mit Pflichtstempel ${r.ms} ms`);
  ok(run.status === 'success', 'neuer Sync mit Pflichtstempel: success');
  ok(Object.keys(TABLES).every((a) => ar[a]?.status === 'success' && ar[a]?.complete), 'alle Bereiche success + complete');
  ok((await versions()) === v0, 'keine zusaetzlichen Inhaltsversionen');
  let rejected = false;
  try { await q(`UPDATE projects SET synced_at = now() WHERE id = (SELECT min(id) FROM projects)`); } catch (e) { rejected = /ohne Lauf-ID/.test(e.message); }
  ok(rejected, 'ungestempelter Abruf-Schreibzugriff wird abgelehnt');
  if (process.env.OLD_CODE) {
    const o = await syncProc('hourly', {}, process.env.OLD_CODE).done;
    const orun = await lastRun();
    ok(orun.status === 'error' && /ohne Lauf-ID/.test(orun.error_message ?? ''), 'alter Sync-Code (main) scheitert bei aktivem Pflichtstempel', (orun.error_message ?? '').slice(0, 80));
    console.log(`alter Code: exit ${o.code}, ${o.ms} ms`);
  }
}

if (stage === 'altcode') {
  // Rollout-Zwischenstand: Migrationen angewendet, alter Code (main) noch aktiv, Pflichtstempel AUS
  await control();
  const v0 = await versions();
  const o = await syncProc('hourly', {}, process.env.OLD_CODE).done;
  const run = await lastRun();
  console.log(`alter Code auf migrierter Kopie: exit ${o.code}, ${o.ms} ms`);
  ok(run.status === 'success', 'alter Sync-Code laeuft auf migrierter Kopie (Pflichtstempel aus)', run.error_message ?? '');
  ok((await versions()) === v0, 'keine zusaetzlichen Inhaltsversionen durch alten Code');
  const unst = Number(await one(`SELECT count(*) FROM projects WHERE last_seen_run_id IS NULL`));
  ok(unst === Number(await one(`SELECT count(*) FROM projects`)), 'alter Code schreibt ungestempelt (last_seen_run_id NULL)', String(unst));
}

console.log(`ERGEBNIS ${stage}: ${pass} bestanden, ${fail} fehlgeschlagen`);
await db.end();
process.exit(fail ? 1 : 0);
