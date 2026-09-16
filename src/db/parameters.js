import { pool } from './pool.js';

export async function getParameter(key, fallback = null) {
  const { rows } = await pool.query(`SELECT value FROM parameters WHERE key = $1`, [key]);
  if (rows.length === 0) return fallback;
  return rows[0].value;
}

export async function getParameterNumber(key, fallback = 0) {
  const v = await getParameter(key, null);
  return v === null ? fallback : Number(v);
}

export async function getAllParameters() {
  const { rows } = await pool.query(`SELECT key, value, beschreibung FROM parameters ORDER BY key`);
  return rows;
}

export async function setParameter(key, value) {
  await pool.query(
    `UPDATE parameters SET value = $2 WHERE key = $1`,
    [key, String(value)]
  );
}
