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
import type { AccountTokensRepo, AuditRepo, SessionsRepo, UsersRepo } from './repo/users';
import type { TicketsRepo } from './repo/tickets';
import type { IntegrationsRepo } from './repo/integrations';
import type { JobsRepo } from './repo/jobs';
import type { InstallsRepo } from './repo/installs';
import type { SettingsRepo } from './repo/settings';
import type { RateLimiter } from './http/rateLimit';
import type { ApiTokensRepo, DeviceCodesRepo } from './repo/apiTokens';

export interface Limiters {
  reportsPerKey: RateLimiter;
  reportsPerIp: RateLimiter;
  configPerIp: RateLimiter;
  loginPerIp: RateLimiter;
  loginPerEmail: RateLimiter;
  /** Inbound GitHub webhooks, per client IP. */
  hooksPerIp: RateLimiter;
  /** "Forgot password?" emails per address, so nobody can mail-bomb a colleague. */
  resetEmailsPerAddress: RateLimiter;
  /** Requests per API token. */
  apiPerToken: RateLimiter;
  /** Device sign-ins started, and polls, per client IP. */
  deviceCodesPerIp: RateLimiter;
  devicePollsPerIp: RateLimiter;
}

export interface Deps {
  config: ServerConfig;
  db: Db;
  now: Clock;
  box: SecretBox;
  mailer: Mailer;
  blobs: BlobStore;
  /** Where scheduled backups go: the SNITCH_BACKUP_S3_* bucket, or `blobs`. */
  backupStore: BlobStore;
  /** Outbound HTTP (GitHub, webhooks). Injected so tests can fake it. */
  fetch: typeof fetch;
  /** Resolves a hostname for the webhook SSRF guard. Injected for tests. */
  lookup: (host: string) => Promise<string[]>;
  projects: ProjectsRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  /** Invite and password-reset links. */
  accountTokens: AccountTokensRepo;
  audit: AuditRepo;
  /** Personal API tokens, and the device sign-in that hands them to the CLI. */
  apiTokens: ApiTokensRepo;
  deviceCodes: DeviceCodesRepo;
  tickets: TicketsRepo;
  integrations: IntegrationsRepo;
  jobs: JobsRepo;
  installs: InstallsRepo;
  settings: SettingsRepo;
  limiters: Limiters;
  /** Nudges the worker to run now (e.g. right after a report completes). */
  wake: () => void;
  /** One-time token for creating the first admin from the dashboard; null once a user exists. */
  setupToken: { value: string | null };
}
