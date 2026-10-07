/**
 * Server entry point: config → database → first admin → worker → HTTP, and a
 * graceful shutdown that drains requests and the worker before closing SQLite.
 */
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { buildDeps } from './bootstrap';
import { buildApp } from './app';
import { startWorker } from './worker/worker';
import { randomToken } from './crypto/tokens';
import { errorMessage, log } from './log';
import { VERSION } from './version';

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = buildDeps(config);

  if (deps.users.count() === 0) {
    if (config.bootstrapAdmin) {
      await deps.users.create({ email: config.bootstrapAdmin.email, role: 'admin', password: config.bootstrapAdmin.password });
      log.info('boot', 'created the first admin from SNITCH_BOOTSTRAP_ADMIN_EMAIL', { email: config.bootstrapAdmin.email });
    } else {
      deps.setupToken.value = randomToken(18);
      log.warn('boot', `No users yet. Create the first admin at ${config.publicUrl}/setup?token=${deps.setupToken.value}`);
    }
  }

  const worker = startWorker(deps);
  deps.wake = worker.poke;
  const app = buildApp(deps);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('boot', `Snitch ${VERSION} listening`, { port: info.port, publicUrl: config.publicUrl, storage: deps.blobs.kind, mail: deps.mailer.driver });
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) process.exit(1);
    closing = true;
    log.info('boot', `${signal} received, shutting down`);
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.stop();
    deps.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('boot', 'failed to start', { error: errorMessage(e) });
  process.exit(1);
});
