import 'dotenv/config';

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
      throw new Error(`Hero API HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors) {
      throw new Error(`Hero API Fehler: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holt alle Seiten einer paginierten Hero-Query (first/offset). */
export async function heroQueryAllPages(buildQuery, rootKey, { pageSize = 500 } = {}) {
  const results = [];
  let offset = 0;
  // Hero deckelt Ergebnisse bei ca. 2000 pro Aufruf -> in Seiten abfragen, bis eine Seite leer/kleiner als pageSize ist.
  while (true) {
    const query = buildQuery(pageSize, offset);
    const data = await heroQuery(query);
    const page = data[rootKey] ?? [];
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}
