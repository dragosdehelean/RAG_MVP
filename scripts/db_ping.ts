import 'dotenv/config';
import dotenv from 'dotenv';
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
import { pool } from '../lib/db';

async function main() {
  const url = process.env.DATABASE_URL;
  console.log(`DATABASE_URL=${url || '(unset)'}`);
  try {
    const { rows } = await pool.query('SELECT version() AS version, current_database() AS db');
    console.log('Connected OK:', rows[0]);
    process.exit(0);
  } catch (e: any) {
    console.error('DB connection failed:', e?.message || e);
    process.exit(1);
  }
}

main();

