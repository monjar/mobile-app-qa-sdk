/**
 * Seeds the e2e server: a project with a known ingest key (via the CLI, before
 * the server opens the database) and, once it's up, two reports sent through
 * scripts/fake-sdk.mjs exactly as a device would.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const INGEST_KEY = 'snitch_pk_E2E00000000000000000000000';
const root = join(import.meta.dirname, '..', '..');

export default async function globalSetup() {
  const dataDir = process.env.SNITCH_E2E_DATA_DIR!;
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, SNITCH_DATA_DIR: dataDir };
  execFileSync('node', [join(root, 'server/dist/cli.js'), 'project:create', '--name', 'Mochiro', '--slug', 'mochiro', '--prefix', 'MOCH', '--ingest-key', INGEST_KEY], { env, stdio: 'inherit' });
  // The webServer starts after globalSetup returns; seed reports from the first test instead.
}
