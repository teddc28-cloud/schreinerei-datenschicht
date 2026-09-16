import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';

export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
  return res.redirect('/login.html');
}

export async function verifyCredentials(username, password) {
  const { rows } = await pool.query(
    `SELECT id, password_hash FROM users WHERE username = $1`,
    [username]
  );
  if (rows.length === 0) return null;
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  return ok ? rows[0].id : null;
}
