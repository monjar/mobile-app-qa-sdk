/**
 * Builds the dependency container from config. Shared by the server, the CLI
 * and tests (which override pieces such as fetch, clock and storage).
 */
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import type { ServerConfig } from './config';
import type { Deps } from './deps';
import { openDb } from './db/open';
import { SecretBox } from './crypto/secretBox';
import { buildMailer } from './mail/mailer';
import { FsBlobStore } from './storage/fsBlobStore';
import { S3BlobStore } from './storage/s3BlobStore';
import { ProjectsRepo } from './repo/projects';
import { AuditRepo, SessionsRepo, UsersRepo } from './repo/users';
import { TicketsRepo } from './repo/tickets';
import { IntegrationsRepo } from './repo/integrations';
import { JobsRepo } from './repo/jobs';
import { RateLimiter } from './http/rateLimit';
import { DAY_MS, HOUR_MS, MINUTE_MS, systemClock } from './util/clock';

export function buildDeps(config: ServerConfig, overrides: Partial<Deps> = {}): Deps {
  const now = overrides.now ?? systemClock;
  const db = overrides.db ?? openDb(config.dbPath);
  const box = overrides.box ?? new SecretBox(config.secretKey, config.previousSecretKey);
  const projects = new ProjectsRepo(db, now);
  const deps: Deps = {
    config,
    db,
    now,
    box,
    mailer: buildMailer(config.smtpUrl, config.mailFrom),
    blobs: config.storage === 's3' && config.s3 ? new S3BlobStore(config.s3) : new FsBlobStore(join(config.dataDir, 'blobs')),
    fetch: globalThis.fetch.bind(globalThis),
    lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    projects,
    users: new UsersRepo(db, now),
    sessions: new SessionsRepo(db, now, config.sessionDays * DAY_MS),
    audit: new AuditRepo(db, now),
    tickets: new TicketsRepo(db, now, projects),
    integrations: new IntegrationsRepo(db, now, box),
    jobs: new JobsRepo(db, now),
    limiters: {
      reportsPerKey: new RateLimiter(config.limits.reportsPerKeyPerHour, HOUR_MS, now),
      reportsPerIp: new RateLimiter(config.limits.reportsPerIpPer10Min, 10 * MINUTE_MS, now),
      configPerIp: new RateLimiter(config.limits.configPerIpPerHour, HOUR_MS, now),
      loginPerIp: new RateLimiter(config.limits.loginPerIpPer15Min, 15 * MINUTE_MS, now),
      loginPerEmail: new RateLimiter(10, 15 * MINUTE_MS, now),
    },
    wake: () => undefined,
    setupToken: { value: null },
    ...overrides,
  };
  return deps;
}
