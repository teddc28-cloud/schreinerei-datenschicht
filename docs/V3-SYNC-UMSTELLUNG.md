# Sync und Dashboard auf Datenschicht-Migration v3 umstellen

Branch `dev/v3-datenschicht-sync`. **Nicht nach `main` mergen, bevor die Migrationen 010–060 auf Produktion angewendet und geprüft sind.**
`main` löst auf Railway einen Auto-Deploy aus. Das gilt für die Services `datenschicht` und `schreinerei-datenschicht`, Letzterer ist das abgestürzte Duplikat. Andere Branches lösen keinen Deploy aus, und PR-Environments sind aus (geprüft am 12.10.2026).

## Was sich ändert

### Sync (`src/sync/*`)
- **Bereichsläufe.**
  - Jeder Bereich läuft als eigener Bereichslauf mit Sperre (`ds.begin_area_run`).
  - Die Sperre wird nach der halben Laufzeit verlängert (`ds.renew_area_lease`).
  - Am Ende stehen Abschluss (`ds.finish_area_run`) und Freigabe (`ds.release_area_lease`, immer im `finally`).
  - Bereiche: projects, wage_groups, documents, document_drafts, receipts, tracking_times.
  - `documents` und `document_drafts` nutzen einen gemeinsamen HERO-Abruf, aber zwei Sperren und zwei Verbindungen.
- **Feste Verbindung, kurze Transaktionen.**
  - Je Bereich `pool.connect()`, je Abrufseite eine Transaktion mit `set_config('ds.run_id', <sync_runs.id>, true)`.
  - Jede ausgeliehene Verbindung hat einen eigenen `error`-Handler (der Pool-Handler gilt nur für ruhende Pool-Verbindungen). Ein Abbruch, auch während der HERO-Abfrage, beendet den Prozess nicht. Die defekte Verbindung wird verworfen (`release(true)`), die Operation läuft mit neuer Verbindung weiter (max. 2 Wiederholungen, `SYNC_CONN_RETRIES`). Danach wird der Bereich als `error` abgeschlossen.
  - Verbindungen tragen `application_name = ds-sync:<bereich>` (sichtbar in `pg_stat_activity`).
- **Strikte API-Antworten.** Nur ein echtes Array ist eine gültige Seite. Fehlt das Datenfeld oder ist es `null`, endet der Bereich mit `error` und `complete=false`, ohne Löschabgleich. Ein echtes leeres Array bleibt ein gültiges Seitenende.
- **Bereichsisolation.**
  - Ein Fehler, auch auf einer späteren API-Seite, betrifft nur den eigenen Bereich. Bereits geschriebene Seiten bleiben gestempelt, der Lauf wird `error` / nicht vollständig.
  - Ein gesperrter Bereich (paralleler Lauf) gilt als übersprungen, nicht als Fehler.
- **Löschabgleich nur als Probelauf.**
  - Nach jedem vollständigen Bereichsabruf läuft `ds.mark_missing_as_deleted(..., p_apply => false)`.
  - Zahlen und bis zu 200 Kandidatenschlüssel landen in `sync_runs.details.<bereich>.loeschabgleich`.
  - Der Code enthält **keinen** Weg, Markierungen anzuwenden. Mit `DELETION_PROBE=off` lässt sich der Probelauf abschalten.
- **Zeitfenster.**
  - Stündlich laufender und letzter Monat (vorher nur der laufende), nachts 3 Monate, Erstlauf 25 Monate.
  - Für `tracking_times` wird das Gesamtfenster an `begin_area_run` übergeben.
  - HERO-Semantik geprüft: `end` ist inklusiv.
- **Zeitzone.**
  - `src/tz.js` setzt die Prozess-TZ auf `Europe/Berlin` (Railway läuft in UTC).
  - DB-Sitzungen laufen mit `TimeZone=Europe/Berlin` (Pool-Option).
- **Fehlertexte.**
  - HTML wird entfernt, Bearer-Muster maskiert, auf 300 Zeichen (Bereich) bzw. 500 Zeichen (`sync_runs`) gekürzt.
- **Scheduler.**
  - Im selben Prozess gibt es keine Überlappung: Ein stündlicher Lauf wird ausgelassen, ein nächtlicher nachgeholt.
  - Zwischen Prozessen mit **neuem** Code schützen die DB-Sperren.
  - **Der alte Code (Stand `main` vor V3) nutzt die Sperren nicht.** Solange der Pflichtstempel aus ist, darf er weiter schreiben, auch parallel zu einem neuen Lauf. Deshalb muss der alte Sync vor dem ersten neuen Lauf nachweislich beendet sein (siehe Rollout, Termin 2).

### Dashboard (`src/server/tiles/*`)
- Alle Abfragen auf Sync-Tabellen filtern `deleted_at IS NULL`. Solange nur Probeläufe laufen, ändert das nichts.
- **Offene Forderungen** (Forderungen-, Geld- und Liquiditätskachel) ohne `status_code 600` (storniert), siehe `offeneRechnungen.js`.
  - Prüfung nach HERO-Semantik: Jede betroffene Rechnung hat eine Stornorechnung über denselben Betrag. Die HERO-Buchung bleibt auf „Teilzahlung“, weil das Storno nicht gegen die Buchung verrechnet wird.
  - Die Fälle bleiben als `storniert_aber_offen` in `ds.v_data_issues` sichtbar.
- **Projektampeln/Werkstatt.**
  - Bei mehreren Entwürfen gleichen Typs und Datums gewinnt die höchste Entwurfs-ID. Vorher war die Auswahl zufällig (physische Zeilenreihenfolge).
  - Die Sortierung ist bei Gleichstand stabil.
- **Statuszeile.** Zusätzlich werden Bereiche mit Problemzustand aus `ds.sync_area_state` angezeigt (`bereiche_mit_problem`).

### Voraussetzung
Der neue Code braucht die Migrationen **010–030** (Sync) und für die Statuszeile 010. Fehlen sie, bricht der Sync mit klarer Meldung ab. Die Dashboard-Abfragen brauchen die Spalte `deleted_at` aus 020.

## Neue Umgebungsvariablen (optional)
| Variable | Standard | Zweck |
|---|---|---|
| `APP_TZ` | `Europe/Berlin` | Zeitzone für Prozess und DB-Sitzung |
| `SYNC_LEASE_SECONDS` | `1800` | Sperrdauer je Bereichslauf |
| `DELETION_PROBE` | `on` | Lösch-Probelauf; `off` schaltet ihn ab. Markiert nie. |
| `SYNC_CONN_RETRIES` | `2` | Wiederholungen je DB-Operation nach Verbindungsabbruch |
| `HERO_TIMEOUT_MS` | `120000` | Zeitlimit je HERO-Anfrage |
| `SCHEDULER_ENABLED` | (gesetzt = an) | Bestehende Variable, alter und neuer Code. `false` = kein automatischer Sync. Wird beim Umstieg genutzt. |

Auf Railway muss **nichts** gesetzt werden.

## Tests
- `npm run test:zeitfenster`: reine Funktionsprüfung von Monatsscheiben, Zeitzone und Fehlertext-Kürzung.
- `tests/sync/run_on_copy.sh <stufe>`: Szenarien gegen eine **wiederhergestellte DB-Kopie** mit kontrolliertem HERO-Ersatz (`tests/sync/mock-hero.mjs`, Fehler und Verzögerungen steuerbar). Stufen:
  - `altcode`: alter Code auf migrierter Kopie
  - `voll`
  - `unveraendert`
  - `seitenfehler`
  - `wiederholung`
  - `sperre`: Sperrablauf und paralleler Start
  - `pflichtstempel`: `require_run_stamp` nur in der Testkopie
  - `verbindung`: Verbindungsabbruch während der HERO-Abfrage (Neuverbindung, Erfolg) und während jeder Schreibtransaktion (Wiederholungen erschöpft, Bereich `error`, Prozess läuft weiter)
  - `antwortfehler`: fehlendes bzw. `null`-Datenfeld nach erfolgreicher Seite (`error`, kein Löschabgleich) und echtes leeres Array (gültiges Seitenende)
- `tests/sync/dashboard_snapshot.mjs` + `diff_snapshots.mjs`: Dashboard-Kennzahlen zweier Code-Stände zum festen Stichtag vergleichen.
- **Nie** gegen Produktion richten. `scenarios.mjs` verweigert Railway-URLs.

Ergebnis am 13.10.2026 auf einer frisch wiederhergestellten Kopie des Backups vom 12.10. (18:15 UTC): **110/110 Szenario-Prüfungen (inkl. `verbindung` 16, `antwortfehler` 14) und 7/7 Funktionsprüfungen bestanden.**

Hinweis aus dem Test: Die Produktion enthält historische `sync_runs` mit Status `running` aus September (abgebrochene Läufe des alten Codes). Prüfpunkt 0 betrachtet deshalb nur die letzten 3 Stunden.

## Rollout – drei getrennte Termine, Reihenfolge verbindlich

### Termin 1: Backup und Migration (Code bleibt alt)
1. **Duplikat-Service `schreinerei-datenschicht` entfernen** oder vom Repo trennen. Er hängt an `main` und würde sonst beim Merge alten bzw. neuen Code zusätzlich starten.
2. **Frisches Backup** (`pg_dump -Fc`, sha256 notieren, außerhalb von Railway ablegen, `pg_restore --list` prüfen).
3. **Migrationen 010–060**: je Stufe `up` + `check`, zwischen zwei Syncs (xx:10–xx:50). 020 blockiert Lesezugriffe ca. 0,7 s.
4. **Beobachtung: mindestens 2 volle Stundenläufe des alten Codes** auf der migrierten DB (getestet: Stufe `altcode`). Danach `checks/0x0_check.sql` lesend. Diese Beobachtung gehört nicht in das 30-Minuten-Fenster von Schritt 2–3.

### Termin 2: Codewechsel (frühestens nach erfolgreicher Beobachtung)
Ziel: Vor dem ersten neuen Lauf ist der alte Sync nachweislich beendet, und kein alter Prozess kann wieder starten. Ausführen zwischen xx:05 und xx:45, also nach dem Stundenlauf und vor dem nächsten (und nicht um 03:17 Uhr).

1. **Prüfpunkt 0 – kein laufender Sync** (lesend):
   ```sql
   SELECT id, started_at FROM sync_runs WHERE status = 'running' AND started_at > now() - interval '3 hours';  -- 0 Zeilen
   ```
2. **Alten Scheduler abschalten**: in Railway beim Service `datenschicht` die Variable `SCHEDULER_ENABLED=false` setzen. Das löst ein Redeploy des **alten** Codes ohne Scheduler aus.
   **Prüfpunkt A:**
   - Railway zeigt genau **ein** aktives Deployment (alter Commit), das vorherige ist „Removed“.
   - Im Log des aktiven Deployments steht `Scheduler deaktiviert (SCHEDULER_ENABLED=false).`
   - Prüfpunkt 0 ist weiterhin 0.
   - Der Service `schreinerei-datenschicht` existiert nicht mehr.
3. **Merge nach `main`** → Auto-Deploy des neuen Codes. `SCHEDULER_ENABLED` steht noch auf `false`, der neue Code startet also ohne Sync. `prestart` führt `schema.sql` aus (idempotent, geprüft).
   **Prüfpunkt B:** genau ein aktives Deployment mit dem neuen Commit, altes „Removed“, Log `Scheduler deaktiviert`, Dashboard lädt.
4. **Zeitpunkt T notieren**, dann `SCHEDULER_ENABLED` entfernen bzw. auf `true` setzen. Das Redeploy des **neuen** Codes startet sofort einen Lauf. Überlappen jetzt zwei Container, ist es zweimal neuer Code, und die Sperren greifen.
5. **Prüfpunkt C nach dem ersten Lauf**:
   - `sync_runs.status = success`
   - `ds.sync_area_state` alle `ok`
   - Lösch-Probelauf-Kandidaten plausibel (erwartet: `document_drafts` ersetzte Entwürfe, `projects` in HERO archivierte Projekte)
   - Dashboard: Offene Forderungen ohne stornierte Restbeträge
   - **Kein ungestempelter Schreibzugriff seit T**: jede Zeile ohne Lauf-ID wäre ein noch laufender Altprozess.
   ```sql
   SELECT 'projects' t, count(*) FROM projects WHERE synced_at > :T AND last_seen_run_id IS NULL
   UNION ALL SELECT 'documents', count(*) FROM documents WHERE synced_at > :T AND last_seen_run_id IS NULL
   UNION ALL SELECT 'document_drafts', count(*) FROM document_drafts WHERE synced_at > :T AND last_seen_run_id IS NULL
   UNION ALL SELECT 'receipts', count(*) FROM receipts WHERE synced_at > :T AND last_seen_run_id IS NULL
   UNION ALL SELECT 'tracking_times', count(*) FROM tracking_times WHERE synced_at > :T AND last_seen_run_id IS NULL
   UNION ALL SELECT 'wage_groups', count(*) FROM wage_groups WHERE synced_at > :T AND last_seen_run_id IS NULL;  -- überall 0
   ```
   Diese Abfrage nach 24 h wiederholen.
- Den Sync **nie** manuell per Railway-Shell mit altem Code starten (`node src/sync/index.js`).

### Termin 3: Pflichtstempel (frühestens 24 h nach Termin 2)
Voraussetzung: 24 h saubere Stunden- und Nachtläufe, der ungestempelt-Check aus Prüfpunkt C ist weiterhin überall 0.
```sql
UPDATE ds.sync_areas SET require_run_stamp = true WHERE source_system = 'hero' AND enabled;
```
Ab dann wird jeder Schreibzugriff eines eventuell doch gestarteten Altprozesses abgelehnt (getestet).

**Löschmarkierung bleibt aus.** Eine eigene Entscheidung fällt nach Auswertung der Probeläufe über mindestens 2 Wochen.

## Rücksetzen
| Stand | Vorgehen |
|---|---|
| Termin 2, Schritt 2 schlägt fehl | `SCHEDULER_ENABLED` entfernen → alter Code läuft wie vorher. |
| Termin 2, nach Schritt 3/4 (neuer Code fehlerhaft) | Wieder ohne Überlappung: (1) `SCHEDULER_ENABLED=false` → neuer Code ohne Sync. (2) Revert-Commit auf `main` → Auto-Deploy alter Code, weiter ohne Sync. Prüfen: ein aktives Deployment, Log `Scheduler deaktiviert`, Prüfpunkt 0 = 0. (3) `SCHEDULER_ENABLED` entfernen → alter Code synct wieder (läuft auf migrierter DB, Pflichtstempel aus; getestet). |
| Prüfpunkt C zeigt ungestempelte Zeilen | Ein Altprozess schreibt noch. Sofort in Railway alle Deployments beider Services prüfen und den alten stoppen bzw. entfernen. Folge: Die betroffenen Zeilen sind ohne Sperrprüfung geschrieben, der Inhalt ist aber HERO-Stand. Der nächste neue Lauf stempelt sie neu. Löschprobeläufe dieses Bereichs melden bis dahin „unplausibel“. |
| Termin 3, Pflichtstempel an | **Zuerst** `UPDATE ds.sync_areas SET require_run_stamp = false;`, **dann** wie oben auf alten Code zurück. Sonst scheitert jeder Abruf des alten Codes (getestet). |
| Migrationen zurücknehmen | Nur **nach** dem Code-Rücksetzen: der neue Code braucht `ds`. Danach `down/060 → 010` laut Migrations-README, vorher Backup. |
| Notbremse ohne Rückbau | Trigger einzeln deaktivieren (Migrations-README Abschnitt 4). Der neue Sync läuft weiter, die Probeläufe melden „unplausibel“. |
| Daten beschädigt | Backup aus Termin 1 einspielen. |

## Offene Entscheidungen
- **Archivierte Projekte und Projekttyp 1.** `project_matches(type: "all")` würde die fehlenden Projekt-IDs schließen. Das ändert aber Mengen in Werkstatt-Kachel und Projektampeln: Projekte mit Status „Kundenrechnung“ kämen hinzu. Bis zur Entscheidung bleiben sie in `ds.v_missing_projects` sichtbar.
- **Belegnummern-Dubletten.** Der Großteil sind HERO-Platzhalternummern (`…xxxx`) von Entwürfen und gelöschten Belegen. `sql/analysen/dubletten.sql` schlüsselt auf. `ds.v_data_issues` sollte Platzhalter künftig ausnehmen; das erfordert eine eigene Migration.
- **Umsatz/USt-Kacheln** zählen stornierte Rechnungen (600) und Stornorechnungen uneinheitlich. Die Kacheln wurden nicht geändert und brauchen eine eigene Prüfung.
