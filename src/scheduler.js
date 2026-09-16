import { runSync } from './sync/index.js';

// Minimaler Eigenbau-Scheduler statt node-cron (spart eine Abhaengigkeit
// samt deren veralteter uuid-Unterabhaengigkeit - siehe npm audit).
// Prueft einmal pro Minute, ob einer der beiden festen Zeitpunkte erreicht ist.

let lastHourlyKey = null;
let lastNightlyKey = null;

function tick() {
  const now = new Date();
  const hourlyKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
  if (now.getMinutes() === 0 && hourlyKey !== lastHourlyKey) {
    lastHourlyKey = hourlyKey;
    runSync('hourly');
  }

  const nightlyKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (now.getHours() === 3 && now.getMinutes() === 17 && nightlyKey !== lastNightlyKey) {
    lastNightlyKey = nightlyKey;
    runSync('nightly');
  }
}

/** Startet den stuendlichen Sync + naechtlichen 90-Tage-Abgleich (03:17 Uhr) im laufenden Prozess. */
export function startScheduler() {
  setInterval(tick, 60 * 1000);
  console.log('Scheduler gestartet: stuendlicher Sync + naechtlicher 90-Tage-Abgleich (03:17 Uhr).');

  // Sofort einen Lauf anstossen, damit der Service nach dem Deploy nicht bis zur naechsten vollen Stunde leer dasteht.
  runSync('hourly');
}
