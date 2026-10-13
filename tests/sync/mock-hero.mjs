// Kontrollierter HERO-Ersatz fuer Sync-Tests. NUR LOKAL. Beantwortet genau die Abfragen aus src/hero/queries.js
// (first/offset-Paginierung, tracking_times mit start/end inklusiv) aus einer JSON-Datei mit Datensaetzen.
// Fehler/Verzoegerungen werden per POST /__control gesetzt, Zugriffe per GET /__stats gezaehlt.
//   node mock-hero.mjs <fixture.json> <port>
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [fixturePath, portArg] = process.argv.slice(2);
const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
const port = Number(portArg ?? 4599);
for (const k of Object.keys(data)) data[k].sort((a, b) => String(a.id ?? a.uuid).localeCompare(String(b.id ?? b.uuid), 'en', { numeric: true }));

let control = { faults: [] }; // { root, page, kind: 'graphql'|'http500'|'html502'|'delay', ms, once, hit }
const stats = {};

function parse(query) {
  const m = query.match(/\{\s*(\w+)\s*\(([^)]*)\)/);
  if (!m) return null;
  const args = {};
  for (const a of m[2].matchAll(/(\w+)\s*:\s*("([^"]*)"|[\w.-]+)/g)) args[a[1]] = a[3] ?? a[2];
  return { root: m[1], args };
}

function rowsFor(root, args) {
  switch (root) {
    case 'project_matches': return data.projects;
    case 'customer_documents': return data.documents;
    case 'Receipt_Receipts': return data.receipts;
    case 'WageGroup_WageGroups': return data.wage_groups;
    case 'tracking_times':
      // HERO: Kalendertage, end inklusiv; start-Zeitstempel tragen den Berliner Offset → Datumsteil = Ortsdatum
      return data.tracking_times.filter((t) => t.start.slice(0, 10) >= args.start && t.start.slice(0, 10) <= args.end);
    default: return null;
  }
}

function wrap(root, rows) {
  if (root === 'Receipt_Receipts' || root === 'WageGroup_WageGroups') return { [root]: { edges: rows.map((node) => ({ node })) } };
  return { [root]: rows };
}

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url === '/__control' && req.method === 'POST') { control = { faults: [], ...JSON.parse(body || '{}') }; for (const k in stats) delete stats[k]; return send(res, 200, { ok: true }); }
    if (req.url === '/__stats') return send(res, 200, stats);
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return send(res, 401, { errors: [{ message: 'unauthorized' }] });
    const { query } = JSON.parse(body || '{}');
    const q = parse(query ?? '');
    if (!q) return send(res, 400, { errors: [{ message: 'unbekannte Abfrage' }] });
    const first = Number(q.args.first ?? 100), offset = Number(q.args.offset ?? 0);
    const page = Math.floor(offset / first) + 1;
    const key = `${q.root}${q.args.start ? `[${q.args.start}..${q.args.end}]` : ''}`;
    stats[key] = (stats[key] ?? 0) + 1;
    for (const f of control.faults) {
      if (f.root !== q.root || (f.page && f.page !== page) || (f.once && f.hit)) continue;
      f.hit = true;
      if (f.kind === 'delay') { await new Promise((r) => setTimeout(r, f.ms)); continue; }
      if (f.kind === 'graphql') return send(res, 200, { errors: [{ message: `Testfehler auf Seite ${page}: ` + 'x'.repeat(2000) }] });
      if (f.kind === 'http500') return send(res, 500, 'Internal Server Error');
      if (f.kind === 'missing') return send(res, 200, { data: {} });                 // Datenfeld fehlt
      if (f.kind === 'null') return send(res, 200, { data: { [q.root]: null } });    // Datenfeld null
      if (f.kind === 'empty') return send(res, 200, { data: wrap(q.root, []) });     // echtes leeres Array
      if (f.kind === 'html502') return send(res, 502, '<html><head><title>502 Bad Gateway</title></head><body>' + '<p>upstream</p>'.repeat(300) + '</body></html>', 'text/html');
    }
    const rows = rowsFor(q.root, q.args);
    if (!rows) return send(res, 400, { errors: [{ message: `Abfrage ${q.root} nicht unterstuetzt` }] });
    send(res, 200, { data: wrap(q.root, rows.slice(offset, offset + first)) });
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-hero auf ${port}: ` + Object.entries(data).map(([k, v]) => `${k}=${v.length}`).join(' ')));
