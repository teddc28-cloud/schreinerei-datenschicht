// Uebergangstest: DB mit ALTEM Code gefuellt, dann NEUER Code. Nur synthetische Daten, nur lokale DB.
import pg from 'pg';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const one = async (s) => Object.values((await db.query(s)).rows[0] ?? {})[0];
const phase = process.argv[2];
const r = {};
r.projekte = Number(await one('select count(*) from projects'));
r.archiviert = Number(await one("select count(*) from projects where raw_json->>'is_deleted'='true'"));
r.kontaktcontainer = Number(await one("select count(*) from projects where raw_json->>'project_type'='copcontact'"));
r.deleted_at_gesetzt = Number(await one('select count(*) from projects where deleted_at is not null'));
r.fehlende_projekte = Number(await one('select count(*) from ds.v_missing_projects'));
r.projekt_unbekannt = Number(await one("select count(*) from ds.v_data_issues where issue='projekt_unbekannt'"));
r.versionen_projects = Object.fromEntries((await db.query("select change_kind, count(*)::int n from ds.record_versions where area='projects' group by 1")).rows.map(x=>[x.change_kind,x.n]));
const last = (await db.query("select details from sync_runs order by id desc limit 1")).rows[0]?.details;
r.loeschkandidaten_projects = last?.projects?.loeschabgleich?.kandidaten;
r.ki_projekte = Number(await one('select count(*) from ki.projekte'));
console.log(phase, JSON.stringify(r));
await db.end();
