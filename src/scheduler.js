import './tz.js'; // zuerst: Stunden/Minuten in deutscher Ortszeit (03:17 Uhr ist 03:17 Uhr in Pyrbaum)
import { runSync } from './sync/index.js';

// Minimaler Eigenbau-Scheduler statt node-cron (spart eine Abhaengigkeit
// samt deren veralteter uuid-Unterabhaengigkeit - siehe npm audit).
// Prueft einmal pro Minute, ob einer der beiden festen Zeitpunkte erreicht ist.
//
// Keine Ueberlappung im selben Prozess: laeuft noch ein Sync, wird ein stuendlicher Lauf ausgelassen,
// ein naechtlicher Lauf wird nachgeholt, sobald der laufende fertig ist. Ueberlappung zwischen
// Prozessen/Services verhindern die Bereichssperren in der Datenbank (ds.begin_area_run).

let lastHourlyKey = null;
let lastNightlyKey = null;
let current = null;
let nightlyPending = false;

function start(mode) {
  if (current) {
    if (mode === 'nightly') {
      nightlyPending = true;
      console.log('Naechtlicher Sync wartet auf laufenden Sync.');
    } else {
      console.log(`Sync (${mode}) ausgelassen: vorheriger Lauf noch aktiv.`);
    }
    return;
  }
  current = runSync(mode)
    .catch((err) => console.error('Sync-Lauf unerwartet abgebrochen:', err?.message ?? err))
    .finally(() => {
      current = null;
      if (nightlyPending) {
        nightlyPending = false;
        start('nightly');
      }
    });
}

function tick() {
  const now = new Date();
  const hourlyKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
  if (now.getMinutes() === 0 && hourlyKey !== lastHourlyKey) {
    lastHourlyKey = hourlyKey;
    start('hourly');
  }

  const nightlyKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (now.getHours() === 3 && now.getMinutes() === 17 && nightlyKey !== lastNightlyKey) {
    lastNightlyKey = nightlyKey;
    start('nightly');
  }
}

/** Startet den stuendlichen Sync + naechtlichen 90-Tage-Abgleich (03:17 Uhr Ortszeit) im laufenden Prozess. */
export function startScheduler() {
  setInterval(tick, 60 * 1000);
  console.log('Scheduler gestartet: stuendlicher Sync + naechtlicher 90-Tage-Abgleich (03:17 Uhr).');

  // Sofort einen Lauf anstossen, damit der Service nach dem Deploy nicht bis zur naechsten vollen Stunde leer dasteht.
  start('hourly');
}
