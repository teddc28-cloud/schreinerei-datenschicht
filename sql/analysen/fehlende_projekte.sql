-- Projekt-IDs, die in Belegen/Zeitbuchungen vorkommen, aber nicht im Projektabruf (project_matches) enthalten sind.
-- NUR LESEND. Befund 12.10.2026 (lesender HERO-Abgleich je ID ueber project_match(project_match_id)):
--   Mehrheit: in HERO geloescht/archiviert (is_deleted = true, Status "Archiviert").
--   Rest: nicht geloescht, aber ein Projekttyp, den der Standardabruf nicht liefert (type_id 1).
--   project_matches(type: "all") liefert beide Gruppen; ohne type-Argument fehlen sie.
--   Paginierung ist NICHT die Ursache (100er/500er Seiten, orderBy id/created: identische ID-Menge, keine Dubletten).
--   Berechtigungen: der vorhandene API-Token liest alle IDs per Einzelabruf → kein Rechteproblem.
--   Zahlen stehen im Analysebericht (nicht im Repository).
--   psql -X -f sql/analysen/fehlende_projekte.sql
BEGIN;  -- nur temporaere Sicht, am Ende ROLLBACK; keine Aenderung an Daten oder Schema
SET LOCAL statement_timeout = '30s';
CREATE TEMP VIEW fehlend AS
SELECT pid,
       count(*) FILTER (WHERE src = 'documents')      AS belege,
       count(*) FILTER (WHERE src = 'documents' AND aktiv) AS belege_aktiv,
       count(*) FILTER (WHERE src = 'tracking_times') AS zeitbuchungen,
       max(d) AS letzte_aktivitaet
FROM (
  SELECT 'documents' AS src, project_match_id AS pid, date AS d, status_code NOT IN ('0', '1000') AS aktiv
  FROM public.documents WHERE project_match_id IS NOT NULL
  UNION ALL
  SELECT 'tracking_times', project_match_id, start::date, true FROM public.tracking_times WHERE project_match_id IS NOT NULL
) x
WHERE NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = x.pid)
GROUP BY pid;

\echo '== Umfang'
SELECT count(*) AS projekt_ids, sum(belege) AS belege, sum(belege_aktiv) AS belege_aktiv, sum(zeitbuchungen) AS zeitbuchungen,
       count(*) FILTER (WHERE belege > 0 AND zeitbuchungen = 0) AS nur_belege,
       count(*) FILTER (WHERE zeitbuchungen > 0 AND belege = 0) AS nur_zeit,
       count(*) FILTER (WHERE belege > 0 AND zeitbuchungen > 0) AS beides
FROM fehlend;
\echo '== letzte Aktivitaet je Quartal'
SELECT date_trunc('quarter', letzte_aktivitaet)::date AS quartal, count(*) FROM fehlend GROUP BY 1 ORDER BY 1;
\echo '== offene Forderungen auf fehlenden Projekten'
SELECT count(*) AS rechnungen_offen, round(sum(booking_balance), 2) AS offen_eur
FROM public.documents d JOIN fehlend f ON f.pid = d.project_match_id WHERE d.booking_is_open;
\echo '== ID-Liste (fuer lesenden HERO-Abgleich)'
SELECT string_agg(pid::text, ',' ORDER BY pid) FROM fehlend;
ROLLBACK;
