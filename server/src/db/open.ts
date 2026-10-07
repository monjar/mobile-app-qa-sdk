/**
 * Opens the SQLite database and brings its schema up to date.
 *
 * WAL lets the dashboard read while the worker writes; busy_timeout covers the
 * CLI running alongside the server. One process owns the file — Snitch runs as
 * a single instance.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this server supports (${migrations.length}). Upgrade Snitch.`,
    );
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
