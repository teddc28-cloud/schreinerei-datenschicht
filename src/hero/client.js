import 'dotenv/config';
import { shortError } from '../utils/errors.js';

const HERO_API_URL = process.env.HERO_API_URL ?? 'https://login.hero-software.de/api/external/v9/graphql';

/**
 * Fuehrt eine GraphQL-Query gegen die Hero API aus.
 * Der Token wird nie geloggt oder zurueckgegeben.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function heroQuery(query, variables = {}, { retries = 3 } = {}) {
  const token = process.env.HERO_API_TOKEN;
  if (!token) throw new Error('HERO_API_TOKEN fehlt in der Umgebung.');

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(HERO_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
        // Eigenes Zeitlimit je Anfrage: sonst koennen Wiederholungen die Bereichssperre (30 min) aufbrauchen
        signal: AbortSignal.timeout(Number(process.env.HERO_TIMEOUT_MS ?? 120000)),
      });
    } catch (networkErr) {
      if (attempt >= retries) throw networkErr;
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new Error(`Hero API HTTP ${res.status}: ${shortError(await res.text(), 200)}`);
    }

    const json = await res.json();
    if (json.errors) {
      throw new Error(`Hero API Fehler: ${shortError(JSON.stringify(json.errors), 200)}`);
    }
    return json.data;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Seitenweiser Abruf (first/offset) als async Iterator: Aufrufer schreiben jede Seite sofort in einer
 * eigenen kurzen Transaktion. `last` = regulaeres Seitenende (Seite kleiner als pageSize).
 * Paginierung geprueft am 12.10.2026: 100er- und 500er-Seiten sowie orderBy id/created liefern
 * dieselbe Menge ohne Dubletten (project_matches).
 */
export async function* heroPages(buildQuery, pickRows, { pageSize = 500 } = {}) {
  let offset = 0;
  for (let page = 1; ; page++) {
    const data = await heroQuery(buildQuery(pageSize, offset));
    const rows = pickRows(data) ?? [];
    const last = rows.length < pageSize;
    yield { page, rows, last };
    if (last) return;
    offset += pageSize;
  }
}
