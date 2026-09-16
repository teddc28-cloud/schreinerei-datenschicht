-- Datenschicht Schema
-- Grundprinzip: Rohdaten roh speichern, Auswertung zur Laufzeit rechnen.
-- Jede Quelltabelle traegt source, synced_at, raw_json.

-- ==========================================================
-- Tabellen aus Hero
-- ==========================================================

CREATE TABLE IF NOT EXISTS projects (
  id                BIGINT PRIMARY KEY,          -- Hero project_match id
  display_id        TEXT,
  name              TEXT,
  volume            NUMERIC,
  status_id         BIGINT,
  status_name       TEXT,                          -- z.B. "In Umsetzung", "Abgeschlossen" - status_id ist pro Projekt eindeutig, nicht als Enum nutzbar
  customer          JSONB,
  created           TIMESTAMPTZ,
  source            TEXT NOT NULL DEFAULT 'hero',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB NOT NULL
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_name TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_status_name ON projects(status_name);

CREATE TABLE IF NOT EXISTS documents (
  nr                TEXT PRIMARY KEY,            -- Hero customer_document nr
  type              TEXT,                        -- offer | invoice | information | ...
  status_code       TEXT,
  status_name       TEXT,
  date              DATE,
  value             NUMERIC,                     -- netto (per API-Stichprobe verifiziert, Pflichtenheft-Annotation "brutto" war falsch)
  vat               NUMERIC,                     -- Steuerbetrag in EUR (nicht Steuersatz); brutto = value + vat
  project_match_id  BIGINT,                       -- kein FK: Sync-Reihenfolge/geloeschte Projekte sollen nie einen Insert blockieren
  booking_is_open     BOOLEAN,                     -- aus customer_document_booking (offene-Forderungen-Logik, Pflichtenheft 5.4)
  booking_due_date    DATE,
  booking_paid_date   DATE,
  booking_balance     NUMERIC,                     -- offener Betrag
  booking_status_name TEXT,
  source            TEXT NOT NULL DEFAULT 'hero',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB NOT NULL
);
-- Additiv fuer bereits bestehende Deployments (CREATE TABLE oben greift nur beim allerersten Anlegen):
ALTER TABLE documents ADD COLUMN IF NOT EXISTS booking_is_open BOOLEAN;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS booking_due_date DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS booking_paid_date DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS booking_balance NUMERIC;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS booking_status_name TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_match_id);
CREATE INDEX IF NOT EXISTS idx_documents_type_date ON documents(type, date);
CREATE INDEX IF NOT EXISTS idx_documents_booking_open ON documents(booking_is_open) WHERE booking_is_open;

CREATE TABLE IF NOT EXISTS document_drafts (
  id                BIGINT PRIMARY KEY,          -- published_customer_document_draft.id
  document_nr       TEXT,
  project_match_id  BIGINT,
  name              TEXT,
  type              TEXT,
  data              JSONB NOT NULL,              -- vollstaendig, hier stecken die Soll-Werte
  source            TEXT NOT NULL DEFAULT 'hero',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_drafts_project ON document_drafts(project_match_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_project_type ON document_drafts(project_match_id, type);

CREATE TABLE IF NOT EXISTS tracking_times (
  uuid                          UUID PRIMARY KEY,
  start                         TIMESTAMPTZ NOT NULL,
  "end"                         TIMESTAMPTZ,
  project_match_id              BIGINT,          -- 0/NULL = keinem Projekt zugeordnet
  tracking_times_category_id    BIGINT,
  partner_id                    BIGINT,          -- selbst gesetzt beim Schreiben (siehe Fallstricke)
  comment                       TEXT,
  source                        TEXT NOT NULL DEFAULT 'hero',
  synced_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json                      JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracking_times_project ON tracking_times(project_match_id);
CREATE INDEX IF NOT EXISTS idx_tracking_times_start ON tracking_times(start);
CREATE INDEX IF NOT EXISTS idx_tracking_times_partner ON tracking_times(partner_id);

CREATE TABLE IF NOT EXISTS wage_groups (
  id                BIGINT PRIMARY KEY,
  name              TEXT,
  wage_cost_price   NUMERIC,                     -- Selbstkosten EUR/h
  wage_per_hour     NUMERIC,                     -- Verkauf EUR/h
  source            TEXT NOT NULL DEFAULT 'hero',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id                BIGINT PRIMARY KEY,          -- Receipt_Receipts id
  date              DATE,
  value             NUMERIC,
  vat               NUMERIC,
  due_date          DATE,                        -- fuer Liquiditaetsvorschau (5.6), offene Verbindlichkeiten
  paid_date         DATE,
  open_amount       NUMERIC,                     -- offener Betrag (brutto)
  -- kein project_match_id verfuegbar (bekannte API-Luecke, siehe Pflichtenheft 8.1)
  source            TEXT NOT NULL DEFAULT 'hero',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB NOT NULL
);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS paid_date DATE;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS open_amount NUMERIC;
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
CREATE INDEX IF NOT EXISTS idx_receipts_open ON receipts(paid_date) WHERE paid_date IS NULL;

CREATE TABLE IF NOT EXISTS payments (
  document_nr      TEXT PRIMARY KEY,
  status_code      TEXT,
  status_name      TEXT,
  source           TEXT NOT NULL DEFAULT 'hero',
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json         JSONB NOT NULL
);

-- ==========================================================
-- Tabellen fuer andere Quellen (Struktur jetzt, Befuellung spaeter)
-- ==========================================================

CREATE TABLE IF NOT EXISTS ledger_balances (
  id                BIGSERIAL PRIMARY KEY,
  konto             TEXT NOT NULL,
  monat             DATE NOT NULL,
  betrag            NUMERIC NOT NULL,
  source            TEXT NOT NULL DEFAULT 'steuerberater',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                BIGSERIAL PRIMARY KEY,
  buchungsdatum     DATE NOT NULL,
  betrag            NUMERIC NOT NULL,
  verwendungszweck  TEXT,
  gegenkonto        TEXT,
  source            TEXT NOT NULL DEFAULT 'sparkasse',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json          JSONB
);

CREATE TABLE IF NOT EXISTS fixed_costs (
  id                BIGSERIAL PRIMARY KEY,
  bezeichnung       TEXT NOT NULL,
  betrag            NUMERIC NOT NULL,
  tag_im_monat      SMALLINT NOT NULL CHECK (tag_im_monat BETWEEN 1 AND 31),
  aktiv             BOOLEAN NOT NULL DEFAULT true
);

-- ==========================================================
-- Betriebstabellen der Datenschicht selbst
-- ==========================================================

CREATE TABLE IF NOT EXISTS parameters (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL,
  beschreibung      TEXT
);

INSERT INTO parameters (key, value, beschreibung) VALUES
  ('stundensatz_selbstkosten', '58.12', 'EUR/h, Rohgewinn / Ist-Lohnkosten'),
  ('stundensatz_verkauf', '75.00', 'EUR/h, Vergleichsrechnungen'),
  ('stundensatz_lehrling_ek', '27.53', 'EUR/h'),
  ('stundensatz_meister_ek', '67.60', 'EUR/h'),
  ('ampel_schwelle_rot', '110', 'Prozent, Projektampeln'),
  ('sync_warnschwelle', '3', 'Stunden, Statusfeld Kopfzeile'),
  ('liquiditaet_horizont', '8', 'Wochen, Liquiditaetsvorschau'),
  ('kontostand', '0', 'EUR, manueller Startwert Liquiditaetsvorschau'),
  ('eingangsrechnungen_warnschwelle', '3', 'Anzahl, unter der die USt-Kachel vor einer moeglicherweise zu hoch ausgewiesenen Zahllast warnt')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  username          TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'owner',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id                BIGSERIAL PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'running', -- running | success | error
  error_message     TEXT,
  details           JSONB
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
