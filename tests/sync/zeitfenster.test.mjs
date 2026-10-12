// Reine Funktionspruefung Zeitfenster/Zeitzone (ohne Datenbank, ohne HERO).
//   node tests/sync/zeitfenster.test.mjs
import '../../src/tz.js';
import assert from 'node:assert/strict';
import { monthSlices, trackingWindow, MONTHS_BACK } from '../../src/sync/trackingTimes.js';
import { shortError } from '../../src/utils/errors.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ', name); };

t('Prozess-Zeitzone ist Europe/Berlin', () => assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Berlin'));

// 01.10.2026 00:30 Ortszeit = 30.09.2026 22:30 UTC: Ein UTC-Prozess haette noch "September" gerechnet.
const kurzNachMitternacht = new Date('2026-09-30T22:30:00Z');
t('stuendlich am Monatsersten 00:30: Oktober + September', () =>
  assert.deepEqual(monthSlices(MONTHS_BACK.hourly, kurzNachMitternacht), [
    { start: '2026-09-01', end: '2026-09-30' },
    { start: '2026-10-01', end: '2026-10-31' },
  ]));
t('Gesamtfenster stuendlich', () => {
  const w = trackingWindow(MONTHS_BACK.hourly, new Date('2026-10-12T10:00:00Z'));
  assert.equal(w.windowFrom, '2026-09-01'); assert.equal(w.windowTo, '2026-10-31');
});
t('naechtlich 3 Monate, Jahreswechsel', () =>
  assert.deepEqual(monthSlices(MONTHS_BACK.nightly, new Date('2027-01-15T02:17:00Z')).map((s) => s.start), ['2026-11-01', '2026-12-01', '2027-01-01']));
t('Schaltjahr Februar', () => assert.deepEqual(monthSlices(1, new Date('2028-02-10T12:00:00Z'))[0], { start: '2028-02-01', end: '2028-02-29' }));
t('Erstlauf 25 Monatsscheiben, aelteste zuerst', () => {
  const s = monthSlices(MONTHS_BACK.initial, new Date('2026-10-12T10:00:00Z'));
  assert.equal(s.length, 25); assert.equal(s[0].start, '2024-10-01'); assert.equal(s[24].end, '2026-10-31');
});
t('Fehlertext: HTML entfernt, gekuerzt, Bearer maskiert', () => {
  const e = shortError('Hero API HTTP 502: <html><body>' + '<p>x</p>'.repeat(500) + '</body></html> Bearer abc.def', 300);
  assert.ok(e.length <= 300); assert.ok(!e.includes('<')); assert.ok(!/abc\.def/.test(shortError('Bearer abc.def')));
});
console.log(`ERGEBNIS zeitfenster: ${n} bestanden, 0 fehlgeschlagen`);
