// EN: Postgres client pool (pg). Uses DATABASE_URL env. Intended for server-side use only.
import dotenv from 'dotenv';
// Load env from .env then .env.local (override) to ensure availability when this module is imported first
dotenv.config();
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Keep it non-fatal for build, but dev should set env.
  console.warn('DATABASE_URL is not set. DB operations will fail.');
}

export const pool = new Pool({ connectionString });

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>
{
  const res = await pool.query(text, params);
  return { rows: res.rows as T[] };
}
