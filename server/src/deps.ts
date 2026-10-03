/**
 * Everything a route or job needs, built once at boot (index.ts) or per test
 * (test/helpers.ts). Keeping it a plain object makes the wiring explicit.
 */
import type { ServerConfig } from './config';
import type { Db } from './db/open';
import type { SecretBox } from './crypto/secretBox';
import type { Mailer } from './mail/mailer';
import type { BlobStore } from './storage/blobStore';
import type { Clock } from './util/clock';
import type { ProjectsRepo } from './repo/projects';
import type { AuditRepo, SessionsRepo, UsersRepo } from './repo/users';
import type { TicketsRepo } from './repo/tickets';
import type { IntegrationsRepo } from './repo/integrations';
import type { JobsRepo } from './repo/jobs';
import type { RateLimiter } from './http/rateLimit';

export interface Limiters {
  reportsPerKey: RateLimiter;
  reportsPerIp: RateLimiter;
  configPerIp: RateLimiter;
  loginPerIp: RateLimiter;
  loginPerEmail: RateLimiter;
}

export interface Deps {
  config: ServerConfig;
  db: Db;
  now: Clock;
  box: SecretBox;
  mailer: Mailer;
  blobs: BlobStore;
  /** Outbound HTTP (GitHub, webhooks). Injected so tests can fake it. */
  fetch: typeof fetch;
  /** Resolves a hostname for the webhook SSRF guard. Injected for tests. */
  lookup: (host: string) => Promise<string[]>;
  projects: ProjectsRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  audit: AuditRepo;
  tickets: TicketsRepo;
  integrations: IntegrationsRepo;
  jobs: JobsRepo;
  limiters: Limiters;
  /** Nudges the worker to run now (e.g. right after a report completes). */
  wake: () => void;
  /** One-time token for creating the first admin from the dashboard; null once a user exists. */
  setupToken: { value: string | null };
}
