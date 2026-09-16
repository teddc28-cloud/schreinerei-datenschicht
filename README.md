# Datenschicht + Betriebsdashboard

Zentrale Datenschicht fuer Schreinerei Scherer e.K.: spiegelt Hero-Daten dauerhaft in
Postgres und zeigt darauf ein Betriebsdashboard fuer den laufenden Monat. Details und
Hintergrund siehe Pflichtenheft (Google Doc, bei Maxi).

## Lokale Entwicklung

```bash
npm install
cp .env.example .env   # Werte eintragen (siehe unten)
npm run migrate        # Schema anlegen/aktualisieren
node src/db/createUser.js <username> <passwort>   # ersten Login-Nutzer anlegen
npm run dev             # Server auf http://localhost:3000
```

`.env`-Variablen:

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | Postgres-Connection-String |
| `HERO_API_TOKEN` | Hero API v9 Token |
| `HERO_API_URL` | Standard: `https://login.hero-software.de/api/external/v9/graphql` |
| `SESSION_SECRET` | Langer Zufallsstring fuer Login-Sessions |
| `PORT` | Standard 3000 |
| `SCHEDULER_ENABLED` | `false` fuer lokale Entwicklung (sonst sofortiger Sync bei jedem `--watch`-Neustart). Auf Railway weglassen oder `true`. |

Manueller Sync-Lauf zum Testen: `node src/sync/index.js hourly` (oder `nightly` / `initial`
fuer den Erstlauf mit zwei Jahren Historie).

## Deploy auf Railway

Ein Service, ein Prozess: `npm start` startet HTTP-Server und stuendlichen Sync-Scheduler
zusammen (siehe `src/scheduler.js`).

1. Dieses Repo auf GitHub pushen.
2. Im bestehenden Railway-Projekt (mit der schon angelegten Postgres-Datenbank) einen
   neuen Service **"+ New" → "GitHub Repo"** anlegen und dieses Repo auswaehlen.
3. Beim neuen Service unter **Variables** setzen:
   - `DATABASE_URL` → als Referenz auf die Postgres-Variable verknuepfen (Railway bietet
     das beim Verbinden zweier Services im selben Projekt automatisch an), oder die
     interne URL `postgresql://postgres:<PASSWORT>@postgres.railway.internal:5432/railway`
     von Hand eintragen.
   - `HERO_API_TOKEN`, `HERO_API_URL`
   - `SESSION_SECRET` (neuer langer Zufallsstring, nicht der lokale)
   - `PORT` muss i.d.R. nicht gesetzt werden, Railway setzt das selbst.
4. Deploy abwarten. `npm start` fuehrt automatisch `prestart` (Schema-Migration) aus,
   danach startet der Server. Der Scheduler stoesst sofort einen ersten Sync an.
5. **Erstlauf mit voller Historie:** einmalig per Railway-Shell/CLI im Service
   `node src/sync/index.js initial` ausfuehren (holt zwei Jahre Zeitbuchungen; der normale
   Scheduler synct nur laufenden + letzten Monat).
6. Ersten Login-Nutzer anlegen: `node src/db/createUser.js <username> <passwort>` ebenfalls
   einmalig in der Railway-Shell.

Danach deployt Railway bei jedem Push auf den verbundenen Branch automatisch neu.
