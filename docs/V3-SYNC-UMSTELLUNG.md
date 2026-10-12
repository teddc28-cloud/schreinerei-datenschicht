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
  - Bei abgerissener Verbindung wird genau einmal mit neuer Verbindung wiederholt.
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
  - Zwischen Prozessen und Services schützen die DB-Sperren.

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
- `tests/sync/dashboard_snapshot.mjs` + `diff_snapshots.mjs`: Dashboard-Kennzahlen zweier Code-Stände zum festen Stichtag vergleichen.
- **Nie** gegen Produktion richten. `scenarios.mjs` verweigert Railway-URLs.

Ergebnis am 12.10.2026 auf der Kopie des Backups vom 12.10. (18:15 UTC): **80/80 Szenario-Prüfungen und 7/7 Funktionsprüfungen bestanden.**

## Rollout – Reihenfolge ist verbindlich
1. **Frisches Backup** (pg_dump `-Fc`, sha256 notieren, außerhalb von Railway ablegen). Optional: `pg_restore --list` prüfen.
2. **Duplikat-Service `schreinerei-datenschicht` entfernen** oder vom Repo trennen. Er hängt ebenfalls an `main` und würde beim Merge mit deployt.
3. **Migrationen 010–060 auf Produktion**: je Stufe `up` + `check`, zwischen zwei Syncs (xx:10–xx:50).
   - Der alte Code läuft danach unverändert weiter; das ist getestet (Stufe `altcode`).
   - 020 blockiert Lesezugriffe auf der Kopie ca. 0,7 s.
4. **1–2 stündliche Läufe abwarten**. `checks/0x0_check.sql` lesend prüfen.
5. **Branch nach `main` mergen** → Auto-Deploy `datenschicht`.
   - `prestart` führt `schema.sql` aus, idempotent und auf migrierter Kopie geprüft.
   - Der Scheduler startet sofort einen Lauf. Läuft der alte Container noch, greifen die Sperren.
6. **Prüfen nach dem ersten Lauf**:
   - `sync_runs.status = success`
   - `ds.sync_area_state` alle `ok`
   - Lösch-Probelauf-Kandidaten je Bereich ansehen; erwartet sind Kandidaten bei `document_drafts` (ersetzte Entwürfe) und `projects` (in HERO archivierte Projekte)
   - Dashboard: Offene Forderungen sinken um die stornierten Restbeträge
7. **Pflichtstempel frühestens nach 24 h** mit sauberem Stunden- und Nachtlauf und erst, wenn sicher **kein** alter Code mehr läuft:
   ```sql
   UPDATE ds.sync_areas SET require_run_stamp = true WHERE source_system = 'hero' AND enabled;
   ```
8. **Löschmarkierung bleibt aus.** Eine eigene Entscheidung fällt nach Auswertung der Probeläufe über mindestens 2 Wochen und nach der Entscheidung zu archivierten Projekten.

## Rücksetzen
| Stand | Vorgehen |
|---|---|
| Nach Schritt 5, Pflichtstempel aus | Railway → datenschicht → vorheriges Deployment „Redeploy“ (oder Revert-Commit auf `main`). Alter Code läuft auf migrierter DB (getestet). |
| Nach Schritt 7, Pflichtstempel an | **Zuerst** `UPDATE ds.sync_areas SET require_run_stamp = false;`, **dann** alten Code deployen. Sonst scheitert jeder Abruf des alten Codes (getestet). |
| Migrationen zurücknehmen | Nur **nach** dem Code-Rücksetzen: der neue Code braucht `ds`. Danach `down/060 → 010` laut Migrations-README, vorher Backup. |
| Notbremse ohne Rückbau | Trigger einzeln deaktivieren (Migrations-README Abschnitt 4). Der neue Sync läuft weiter, die Probeläufe melden „unplausibel“. |
| Daten beschädigt | Backup aus Schritt 1 einspielen. |

## Offene Entscheidungen
- **Archivierte Projekte und Projekttyp 1.** `project_matches(type: "all")` würde die fehlenden Projekt-IDs schließen. Das ändert aber Mengen in Werkstatt-Kachel und Projektampeln: Projekte mit Status „Kundenrechnung“ kämen hinzu. Bis zur Entscheidung bleiben sie in `ds.v_missing_projects` sichtbar.
- **Belegnummern-Dubletten.** Der Großteil sind HERO-Platzhalternummern (`…xxxx`) von Entwürfen und gelöschten Belegen. `sql/analysen/dubletten.sql` schlüsselt auf. `ds.v_data_issues` sollte Platzhalter künftig ausnehmen; das erfordert eine eigene Migration.
- **Umsatz/USt-Kacheln** zählen stornierte Rechnungen (600) und Stornorechnungen uneinheitlich. Die Kacheln wurden nicht geändert und brauchen eine eigene Prüfung.
