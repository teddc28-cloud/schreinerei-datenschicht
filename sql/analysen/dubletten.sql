-- Aufschluesselung "nummer_doppelt" (ds.v_data_issues) nach Gruppen aus Belegnummer + Dokumenttyp.
-- NUR LESEND. Fuehrt nichts zusammen und loescht nichts. Ausgabe ohne Kunden-/Projektnamen.
--   psql -X -f sql/analysen/dubletten.sql
BEGIN;  -- nur temporaere Sicht, am Ende ROLLBACK; keine Aenderung an Daten oder Schema
SET LOCAL statement_timeout = '30s';

CREATE TEMP VIEW dubl_gruppen AS
SELECT nr, type,
       count(*)                                                         AS datensaetze,
       count(*) FILTER (WHERE status_code NOT IN ('0', '1000'))         AS aktiv,
       count(*) FILTER (WHERE status_code = '1000')                     AS in_hero_geloescht,
       count(*) FILTER (WHERE status_code = '0')                        AS entwurf,
       count(*) FILTER (WHERE status_name LIKE '%Hochgeladen%')         AS hochgeladen,
       count(DISTINCT project_match_id)                                 AS projekte,
       count(DISTINCT value) FILTER (WHERE status_code NOT IN ('0', '1000')) AS versch_betraege_aktiv,
       CASE
         WHEN nr ~ 'x{4}$' AND count(*) FILTER (WHERE status_code NOT IN ('0', '1000')) = 0
           THEN '1 Platzhalternummer (…xxxx), nur Entwurf/in HERO geloescht – keine echte Dublette'
         WHEN nr ~ 'x{4}$' THEN '2 Platzhalternummer mit aktivem Beleg – pruefen'
         WHEN count(*) FILTER (WHERE status_code NOT IN ('0', '1000')) <= 1
           THEN '3 echte Nummer, hoechstens 1 aktiv, Rest geloescht/Entwurf'
         WHEN count(DISTINCT project_match_id) = 1 THEN '4 echte Nummer, mehrfach aktiv, gleiches Projekt – pruefen'
         ELSE '5 echte Nummer, mehrfach aktiv, verschiedene Projekte – pruefen'
       END AS kategorie
FROM public.documents
WHERE nr <> ''
GROUP BY nr, type
HAVING count(*) > 1;

\echo '== Summe (entspricht nummer_doppelt in ds.v_data_issues, solange keine Loeschmarkierungen gesetzt sind)'
SELECT count(*) AS gruppen, sum(datensaetze) AS datensaetze FROM dubl_gruppen;

\echo '== nach Kategorie'
SELECT kategorie, count(*) AS gruppen, sum(datensaetze) AS datensaetze, sum(aktiv) AS aktiv,
       sum(in_hero_geloescht) AS geloescht, sum(entwurf) AS entwurf, sum(hochgeladen) AS hochgeladen
FROM dubl_gruppen GROUP BY kategorie ORDER BY kategorie;

\echo '== nach Dokumenttyp'
SELECT type, count(*) AS gruppen, sum(datensaetze) AS datensaetze, max(datensaetze) AS groesste_gruppe
FROM dubl_gruppen GROUP BY type ORDER BY 3 DESC;

\echo '== pruefwuerdige Gruppen (Kategorie 2, 4, 5) – Belegnummer und Kennzahlen, keine Namen'
SELECT kategorie, type, nr, datensaetze, aktiv, projekte, hochgeladen, versch_betraege_aktiv
FROM dubl_gruppen WHERE left(kategorie, 1) IN ('2', '4', '5') ORDER BY kategorie, type, nr;
ROLLBACK;
