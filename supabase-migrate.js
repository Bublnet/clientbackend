import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { Client } = pg;

let migrationPromise;

export function ensureSupabaseSchema() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = migrate();
  return migrationPromise;
}

async function migrate() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.warn('[clientbackend] SUPABASE_DB_URL is missing; automatic table creation is disabled.');
    return { migrated: false, reason: 'not-configured' };
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('dvenue_supabase_schema_v1'))");
    const sql = await fs.readFile(new URL('./supabase-schema.sql', import.meta.url), 'utf8');
    await client.query(sql);
    console.log('[clientbackend] Supabase tables are ready.');
    return { migrated: true };
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('dvenue_supabase_schema_v1'))").catch(() => {});
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  ensureSupabaseSchema().catch((error) => {
    console.error('[clientbackend] Supabase migration failed:', {
      message: error.message || String(error),
      code: error.code || null,
    });
    process.exitCode = 1;
  });
}
