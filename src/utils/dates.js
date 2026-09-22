export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** YYYY-MM-DD aus den lokalen Datumskomponenten - toISOString() rechnet auf UTC um und
 * verschiebt dadurch das Datum je nach Server-Zeitzone um bis zu einen Tag. */
export function formatLocalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Montag der Woche, in der `date` liegt (lokale Kalenderwoche, nicht rollierend). */
export function mondayOfWeek(date) {
  const d = startOfDay(date);
  const dayIndex = (d.getDay() + 6) % 7; // Montag = 0 .. Sonntag = 6
  return addDays(d, -dayIndex);
}

/** ISO-8601-Kalenderwoche (deutsche Zaehlweise, Montag-Start, KW 1 enthaelt den ersten Donnerstag des Jahres). */
export function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return { woche: 1 + Math.round((d - firstThursday) / (7 * 86400000)), jahr: d.getUTCFullYear() };
}
