import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Nutzung: node src/db/createUser.js <username> <passwort>');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

await pool.query(
  `INSERT INTO users (username, password_hash, role)
   VALUES ($1, $2, 'owner')
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
  [username, hash]
);

console.log(`Nutzer "${username}" angelegt/aktualisiert.`);
await pool.end();
