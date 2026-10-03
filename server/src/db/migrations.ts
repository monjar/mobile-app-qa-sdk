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
];
