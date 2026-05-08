import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Logger } from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev: src/db -> ../../migrations = <repo>/migrations
// In prod (compiled): dist/db -> ../../migrations = /app/migrations (Dockerfile copies it)
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export async function runMigrations(pool: Pool, log: Logger): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const exists = await pool.query<{ id: string }>('SELECT id FROM _migrations WHERE id = $1', [
      file,
    ]);
    if ((exists.rowCount ?? 0) > 0) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    log.info('applying migration', { id: file });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
