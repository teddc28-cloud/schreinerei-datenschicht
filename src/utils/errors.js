/**
 * Fehlertext fuer Protokolle kuerzen: HTML-Fehlerseiten (z. B. 502 vom Gateway), Zeilenumbrueche
 * und Riesentexte aus GraphQL-Antworten landen sonst ungekuerzt in sync_runs.error_message.
 * Tokens tauchen in Fehlertexten nicht auf (der Client gibt sie nie aus), Bearer-Muster werden
 * trotzdem vorsorglich ersetzt.
 */
export function shortError(err, max = 300) {
  const raw = typeof err === 'string' ? err : err?.message ?? String(err);
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
