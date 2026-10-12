import { heroPages } from '../hero/client.js';
import { RECEIPTS_QUERY } from '../hero/queries.js';
import { safeJsonStringify } from '../utils/safeJson.js';

export async function syncReceipts(run) {
  const pick = (d) => d.Receipt_Receipts.edges.map((e) => e.node);
  for await (const { rows, last } of heroPages(RECEIPTS_QUERY, pick, { pageSize: 200 })) {
    await run.writeTx(async (c) => {
      for (const r of rows) {
        // statedTotalVat ist in der Praxis durchgehend null (per Stichprobe verifiziert) -
        // Vorsteuer stattdessen aus brutto (value) minus netto (netValue) rechnen.
        const netValue = r.netValue ?? r.value;
        const vat = r.statedTotalVat ?? (r.value != null && r.netValue != null ? r.value - r.netValue : null);
        await c.query(
          `INSERT INTO receipts (id, date, value, vat, due_date, paid_date, open_amount, synced_at, raw_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
           ON CONFLICT (id) DO UPDATE SET
             date = EXCLUDED.date,
             value = EXCLUDED.value,
             vat = EXCLUDED.vat,
             due_date = EXCLUDED.due_date,
             paid_date = EXCLUDED.paid_date,
             open_amount = EXCLUDED.open_amount,
             synced_at = now(),
             raw_json = EXCLUDED.raw_json`,
          [r.id, r.receiptDate, netValue, vat, r.dueDate, r.paidDate, r.openAmount, safeJsonStringify(r)]
        );
      }
      return rows.map((r) => r.id);
    });
    if (last) return { complete: true };
  }
  return { complete: true };
}
