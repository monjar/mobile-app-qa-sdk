/**
 * Server-wide key-value state that isn't configuration (configuration comes
 * from the environment), such as the outcome of the last scheduled backup.
 */
import type { Db } from '../db/open';
import type { Clock } from '../util/clock';
import { parseJson, toJson } from '../util/json';

export class SettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return parseJson(r?.value_json, fallback);
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(key, toJson(value), this.now());
  }
}
