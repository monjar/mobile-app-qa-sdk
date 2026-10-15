/**
 * Ordered schema migrations, tracked in PRAGMA user_version. Each step runs in
 * a transaction and never changes once released: fix forward with a new step.
 * Self-hosters may jump several versions at once, so steps must not assume the
 * previous release's code ran in between.
 *
 * Times are epoch milliseconds; ids are ULIDs.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — initial schema
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ticket_prefix TEXT NOT NULL,
    next_ticket_number INTEGER NOT NULL DEFAULT 1,
    report_types_json TEXT NOT NULL,
    allowed_app_ids_json TEXT,
    allowed_release_types_json TEXT NOT NULL,
    retention_days INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );

  CREATE TABLE ingest_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    disabled_at INTEGER
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_by_user ON sessions(user_id);

  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    client_report_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','triaged','in_progress','resolved','wont_fix','duplicate')),
    upload_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (upload_state IN ('pending','complete','incomplete')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reporter_email TEXT,
    reporter_name TEXT,
    reporter_id TEXT,
    platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
    release_type TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_version TEXT NOT NULL,
    app_build TEXT NOT NULL,
    os_version TEXT NOT NULL,
    device_model TEXT NOT NULL,
    sdk_version TEXT NOT NULL,
    trigger TEXT,
    metadata_json TEXT NOT NULL,
    assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    duplicate_of_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    reported_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, number),
    UNIQUE (project_id, client_report_id)
  );
  CREATE INDEX tickets_inbox ON tickets(project_id, status, created_at DESC);
  CREATE INDEX tickets_by_created ON tickets(created_at DESC);
  CREATE INDEX tickets_pending ON tickets(upload_state, created_at);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    declared_size INTEGER NOT NULL,
    declared_sha256 TEXT NOT NULL,
    size_bytes INTEGER,
    sha256 TEXT,
    storage_key TEXT,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    state TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('missing','stored')),
    created_at INTEGER NOT NULL,
    stored_at INTEGER,
    UNIQUE (ticket_id, name)
  );

  CREATE TABLE ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('sdk','user','system','integration')),
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ticket_events_by_ticket ON ticket_events(ticket_id, id);

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('github','email','webhook')),
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    secret_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE routing_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    report_type TEXT NOT NULL,
    integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('auto','suggest')),
    position INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX routing_by_project ON routing_rules(project_id, position);

  CREATE TABLE escalations (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('queued','sent','failed')),
    external_id TEXT,
    external_url TEXT,
    last_error TEXT,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (ticket_id, integration_id)
  );

  CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX share_links_by_attachment ON share_links(attachment_id);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 8,
    run_at INTEGER NOT NULL,
    locked_at INTEGER,
    last_error TEXT,
    dedupe_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(state, run_at);

  CREATE TABLE sdk_configs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    release_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, platform, release_type)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_by_time ON audit_log(created_at DESC);
  `,

  // 2 — 0.3: device check-ins, chunked uploads, notifications, GitHub sync and sign-in, scheduled backups
  `
  ALTER TABLE projects ADD COLUMN notify_assignees INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE projects ADD COLUMN notify_reporters INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE tickets ADD COLUMN install_id TEXT;
  ALTER TABLE tickets ADD COLUMN screen TEXT;
  ALTER TABLE tickets ADD COLUMN fixed_in TEXT;
  CREATE INDEX tickets_by_install ON tickets(project_id, install_id) WHERE install_id IS NOT NULL;
  CREATE INDEX tickets_by_build ON tickets(project_id, platform, app_version, app_build);

  -- Verified bytes of a chunked upload in <dataDir>/tmp/partial/<id>.part.
  ALTER TABLE attachments ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;

  -- Id of the outside thing an event mirrors (a GitHub comment), so a redelivered webhook is a no-op.
  ALTER TABLE ticket_events ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX ticket_events_external ON ticket_events(ticket_id, kind, external_id) WHERE external_id IS NOT NULL;

  -- Signing secret GitHub uses for issue webhooks (sealed like secret_enc).
  ALTER TABLE integrations ADD COLUMN webhook_secret_enc TEXT;

  ALTER TABLE users ADD COLUMN github_id INTEGER;
  ALTER TABLE users ADD COLUMN github_login TEXT;
  CREATE UNIQUE INDEX users_by_github_id ON users(github_id) WHERE github_id IS NOT NULL;

  -- One row per SDK install, from the config fetches it makes (installId is random per install).
  CREATE TABLE installs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    install_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    release_type TEXT NOT NULL,
    app_id TEXT,
    app_version TEXT,
    build TEXT,
    os TEXT,
    model TEXT,
    sdk_version TEXT,
    wrapper TEXT,
    signals TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    health TEXT,
    config_enabled INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    checkins INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, install_id)
  );
  CREATE INDEX installs_by_seen ON installs(project_id, last_seen_at DESC);
  CREATE INDEX installs_by_last_seen ON installs(last_seen_at);

  -- Small server-wide state (e.g. the last backup), one JSON value per key.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // 3 — 0.4: email invites and password-reset links
  `
  -- One-time links to choose a password. Only the token's SHA-256 is stored.
  CREATE TABLE account_tokens (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX account_tokens_by_user ON account_tokens(user_id, purpose);
  `,

  // 4 — 0.5: personal API tokens and device sign-in (the snitch CLI)
  `
  -- Bearer tokens that act as their user, limited to scopes. Only the token's SHA-256 is stored.
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    via_device INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX api_tokens_by_user ON api_tokens(user_id, created_at);

  -- Pending device sign-ins. The token is minted when the CLI polls after approval,
  -- so no plaintext token is ever stored here.
  CREATE TABLE device_codes (
    device_code_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    token_days INTEGER,
    ip TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    interval_s INTEGER NOT NULL,
    last_polled_at INTEGER,
    approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    approved_at INTEGER,
    denied_at INTEGER,
    token_id TEXT
  );
  CREATE INDEX device_codes_by_expiry ON device_codes(expires_at);
  `,
];
