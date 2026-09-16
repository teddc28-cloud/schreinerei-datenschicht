import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  max: 5,
});

// Pool selbst darf einzelne Idle-Verbindungsfehler nicht killen (passiert bei der
// oeffentlichen Railway-Proxy-Verbindung gelegentlich) - sonst crasht der Prozess.
pool.on('error', (err) => {
  console.error('Postgres Pool-Fehler (ignoriert, naechste Query holt neue Verbindung):', err.message);
});

const TRANSIENT_DB_ERRORS = ['Connection terminated', 'ECONNRESET', 'ETIMEDOUT', 'connection reset'];

function isTransient(err) {
  return TRANSIENT_DB_ERRORS.some((m) => err?.message?.includes(m));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wie pool.query, aber mit Retry bei abgerissenen Verbindungen (oeffentliche Proxy-URL ist manchmal wacklig). */
export async function dbQuery(text, params, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (!isTransient(err) || attempt >= retries) throw err;
      await sleep(2 ** attempt * 500);
    }
  }
}
