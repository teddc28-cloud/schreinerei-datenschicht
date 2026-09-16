import { pool } from '../db/pool.js';
import { getParameterNumber, getAllParameters, setParameter } from '../db/parameters.js';

// kontostand hat sein eigenes Feld im Dashboard (direkt an der Liquiditaetskachel) -
// alle anderen Parameter laufen ueber die generische Tabelle.
const EIGENES_FELD = new Set(['kontostand']);

export async function getSettings() {
  const [kontostand, alleParameter, { rows: fixedCosts }] = await Promise.all([
    getParameterNumber('kontostand', 0),
    getAllParameters(),
    pool.query(`SELECT id, bezeichnung, betrag, tag_im_monat, aktiv FROM fixed_costs ORDER BY tag_im_monat, bezeichnung`),
  ]);
  return {
    kontostand,
    parameter: alleParameter.filter((p) => !EIGENES_FELD.has(p.key)),
    fixed_costs: fixedCosts,
  };
}

export async function setKontostand(value) {
  await setParameter('kontostand', value);
}

export async function updateParameterValue(key, value) {
  if (EIGENES_FELD.has(key)) throw new Error('kontostand hat ein eigenes Feld, nicht ueber /parameters aendern');
  await setParameter(key, value);
}

export async function createFixedCost({ bezeichnung, betrag, tag_im_monat }) {
  const { rows } = await pool.query(
    `INSERT INTO fixed_costs (bezeichnung, betrag, tag_im_monat) VALUES ($1, $2, $3) RETURNING id`,
    [bezeichnung, betrag, tag_im_monat]
  );
  return rows[0].id;
}

export async function updateFixedCost(id, { bezeichnung, betrag, tag_im_monat, aktiv }) {
  await pool.query(
    `UPDATE fixed_costs SET bezeichnung = $2, betrag = $3, tag_im_monat = $4, aktiv = $5 WHERE id = $1`,
    [id, bezeichnung, betrag, tag_im_monat, aktiv]
  );
}

export async function deleteFixedCost(id) {
  await pool.query(`DELETE FROM fixed_costs WHERE id = $1`, [id]);
}
