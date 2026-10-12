// Dashboard-Kennzahlen einer Code-Version gegen eine Testdatenbank, fester Stichtag. Gibt JSON aus (nur Kennzahlen).
//   DATABASE_URL=... node tests/sync/dashboard_snapshot.mjs <repo-wurzel>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const STICHTAG = new Date('2026-10-12T10:00:00Z'); // 12:00 Uhr Ortszeit, gleicher Zeitpunkt unabhaengig von TZ
const t = {
  forderungen: (await imp('src/server/tiles/forderungen.js')).getForderungenKachel,
  ust: (await imp('src/server/tiles/ust.js')).getUstKachel,
  rohgewinn: (await imp('src/server/tiles/rohgewinn.js')).getRohgewinnKachel,
  projektampeln: (await imp('src/server/tiles/projektampeln.js')).getProjektampelnKachel,
  liquiditaet: (await imp('src/server/tiles/liquiditaet.js')).getLiquiditaetKachel,
  reichts: (await imp('src/server/tiles/reichts.js')).getReichtsKachel,
  werkstatt: (await imp('src/server/tiles/werkstatt.js')).getWerkstattKachel,
  geld: (await imp('src/server/tiles/geld.js')).getGeldKachel,
  pipeline: (await imp('src/server/tiles/pipeline.js')).getPipelineKachel,
};
const out = {};
for (const [k, f] of Object.entries(t)) out[k] = await f(STICHTAG);
// Projekt-/Namensfelder entfernen (keine Kundendaten im Vergleich), nur Zahlen behalten
const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !['name', 'display_id', 'id', 'bezeichnung'].includes(k)).map(([k, x]) => [k, strip(x)])) : v;
console.log(JSON.stringify(strip(out)));
const { pool } = await imp('src/db/pool.js');
await pool.end();
