import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { requireAuth, verifyCredentials } from './auth.js';
import { getSyncStatus } from './tiles/status.js';
import { getUmsatzKachel } from './tiles/umsatz.js';
import { getForderungenKachel } from './tiles/forderungen.js';
import { getUstKachel } from './tiles/ust.js';
import { getRohgewinnKachel } from './tiles/rohgewinn.js';
import { getProjektampelnKachel } from './tiles/projektampeln.js';
import { getLiquiditaetKachel } from './tiles/liquiditaet.js';
import { startScheduler } from '../scheduler.js';
import {
  getSettings,
  setKontostand,
  updateParameterValue,
  createFixedCost,
  updateFixedCost,
  deleteFixedCost,
} from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET ?? 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });

  const userId = await verifyCredentials(username, password);
  if (!userId) return res.status(401).json({ error: 'invalid_credentials' });

  req.session.userId = userId;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: Boolean(req.session?.userId) });
});

app.get('/api/dashboard', requireAuth, async (req, res, next) => {
  try {
    const [status, umsatz, forderungen, ust, rohgewinn, projektampeln, liquiditaet] = await Promise.all([
      getSyncStatus(),
      getUmsatzKachel(),
      getForderungenKachel(),
      getUstKachel(),
      getRohgewinnKachel(),
      getProjektampelnKachel(),
      getLiquiditaetKachel(),
    ]);
    res.json({ status, umsatz, forderungen, ust, rohgewinn, projektampeln, liquiditaet });
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', requireAuth, async (req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings/kontostand', requireAuth, async (req, res, next) => {
  try {
    const value = Number(req.body?.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'invalid_value' });
    await setKontostand(value);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings/parameter/:key', requireAuth, async (req, res, next) => {
  try {
    const value = req.body?.value;
    if (value === undefined || value === null || value === '') {
      return res.status(400).json({ error: 'invalid_value' });
    }
    await updateParameterValue(req.params.key, value);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/settings/fixed-costs', requireAuth, async (req, res, next) => {
  try {
    const { bezeichnung, betrag, tag_im_monat } = req.body ?? {};
    if (!bezeichnung || !Number.isFinite(Number(betrag)) || !Number.isInteger(Number(tag_im_monat))) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const id = await createFixedCost({ bezeichnung, betrag: Number(betrag), tag_im_monat: Number(tag_im_monat) });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

app.put('/api/settings/fixed-costs/:id', requireAuth, async (req, res, next) => {
  try {
    const { bezeichnung, betrag, tag_im_monat, aktiv } = req.body ?? {};
    await updateFixedCost(req.params.id, {
      bezeichnung,
      betrag: Number(betrag),
      tag_im_monat: Number(tag_im_monat),
      aktiv: Boolean(aktiv),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/settings/fixed-costs/:id', requireAuth, async (req, res, next) => {
  try {
    await deleteFixedCost(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Login-Seite und statische Assets sind frei zugaenglich, alles andere braucht eine Session.
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/assets/')) return next();
  return requireAuth(req, res, next);
});
app.use(express.static(publicDir));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`Dashboard laeuft auf Port ${port}`));

// In der lokalen Entwicklung (node --watch) per SCHEDULER_ENABLED=false abschaltbar,
// sonst wuerde jeder Datei-Speicher-Neustart einen sofortigen Hero-Sync anstossen.
if (process.env.SCHEDULER_ENABLED !== 'false') {
  startScheduler();
} else {
  console.log('Scheduler deaktiviert (SCHEDULER_ENABLED=false).');
}
