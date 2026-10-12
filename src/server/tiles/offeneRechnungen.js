/**
 * Gemeinsame Bedingung fuer offene Ausgangsrechnungen (Forderungen-, Geld- und Liquiditaetskachel).
 *
 * status_code 600 (Storniert) ist ausgeschlossen. Pruefung HERO-Semantik am 12.10.2026 (Backup-Kopie und
 * lesender HERO-Abruf): Jede stornierte Rechnung mit offener Buchung hat im selben Projekt eine
 * Stornorechnung (type reversal_invoice) ueber denselben Betrag; die Buchung steht in HERO weiterhin auf
 * "Teilzahlung"/offen, weil die Stornorechnung nicht gegen die Buchung verrechnet wird. Der Restbetrag ist
 * keine Forderung. Die Faelle bleiben in ds.v_data_issues als "storniert_aber_offen" sichtbar.
 *
 * deleted_at IS NULL: in der Quelle als geloescht erkannte Datensaetze (derzeit nur Probelauf, keine Markierung).
 */
export const OFFENE_RECHNUNGEN_WHERE =
  "type = 'invoice' AND booking_is_open = true AND status_code IS DISTINCT FROM '600' AND deleted_at IS NULL";
