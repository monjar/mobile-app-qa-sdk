# Running the Snitch server

The server is one process: report intake for the SDKs, the admin dashboard, a background worker for escalations,
and SQLite + files for storage. It is built to run as a single instance with a persistent volume.

## Quick start

```sh
docker run -d --name snitch -p 8080:8080 -v snitch-data:/data \
  -e SNITCH_PUBLIC_URL=https://snitch.example.com \
  ghcr.io/monjar/snitch-server:latest

docker logs snitch | grep setup
```

Open the one-time link from that log line to create the first admin.

Then, in the dashboard: **New project** → copy the ingest key → follow the **Install** tab for your platform.

`SNITCH_PUBLIC_URL` is the address people and integrations reach the server at. It appears in GitHub issues,
emails and share links, and the dashboard's CSRF check compares against it.

### Docker Compose (with automatic TLS)

```sh
curl -O https://raw.githubusercontent.com/monjar/mobile-app-qa-sdk/master/server/docker-compose.yml
curl -O https://raw.githubusercontent.com/monjar/mobile-app-qa-sdk/master/server/Caddyfile
SNITCH_DOMAIN=snitch.example.com SNITCH_PUBLIC_URL=https://snitch.example.com SNITCH_TRUST_PROXY=xff \
  docker compose --profile tls up -d
```

Without `--profile tls` only Snitch starts, on port 8080, for use behind your own proxy.

### Fly.io

Copy [`server/fly.toml.example`](../server/fly.toml.example) to `fly.toml`, change `app` and `SNITCH_PUBLIC_URL`, then:

```sh
fly apps create <app>
fly volumes create snitch_data --size 3 --region lhr
fly deploy --image ghcr.io/monjar/snitch-server:latest
fly logs | grep setup
```

### Without Docker

Node 22.13+ (24 recommended):

```sh
npm ci && npm run build
SNITCH_PUBLIC_URL=http://localhost:8080 SNITCH_DATA_DIR=./data node server/dist/index.js
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SNITCH_PUBLIC_URL` | `http://localhost:$PORT` | External URL, used in links. Must be `https://…` in production (cookies get the `Secure` flag). |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |
| `SNITCH_DATA_DIR` | `/data` in Docker, `./data` otherwise | SQLite database, attachments (`blobs/`), temp uploads, generated secret key. |
| `SNITCH_SECRET_KEY` | generated into `<data>/secret.key` | Encrypts integration tokens at rest. ≥ 32 characters. Set it explicitly if your data volume is not private. |
| `SNITCH_PREVIOUS_SECRET_KEY` | — | Old key during rotation; secrets are still readable with it. |
| `SNITCH_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | — | Creates the first admin on boot instead of the setup link. |
| `SNITCH_SMTP_URL` | — | `smtp://user:pass@host:587` or `smtps://…:465`. Needed for invites, "Forgot password?", notifications and email escalations; without it, email escalations fail with a clear error and invite links are shown to the admin instead. |
| `SNITCH_MAIL_FROM` | `Snitch <snitch@localhost>` | Sender for every email Snitch sends. |
| `SNITCH_STORAGE` | `fs` | `fs` (data volume) or `s3`. |
| `SNITCH_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE` | — / `auto` / `true` | Any S3-compatible store (AWS, Cloudflare R2, SeaweedFS, Garage). |
| `SNITCH_RETENTION_DAYS` | `90` | Tickets older than this are deleted with their media. `0` keeps everything. Projects can override. |
| `SNITCH_UPLOAD_CHUNK_BYTES` | `1048576` | Chunk size the server asks SDKs to use for resumable uploads, clamped to 64 KiB–8 MiB. Lower it on very flaky networks. |
| `SNITCH_BACKUP_INTERVAL_HOURS` | `0` (off) | Hours between scheduled database backups. See [Backups](#backups). |
| `SNITCH_BACKUP_KEEP` | `7` | Backups kept; older ones are deleted after each run. |
| `SNITCH_BACKUP_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE`, `_PREFIX` | — / — / `auto` / — / — / `true` / `snitch-backups/` | A separate bucket for backups. Without it, backups go to the attachment store under `backups/`. |
| `SNITCH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | — | Turns on **Sign in with GitHub** (an OAuth app). See [Sign in with GitHub](#sign-in-with-github). |
| `SNITCH_GITHUB_ALLOWED_ORG` | — | Only active members of this GitHub organization may sign in with GitHub. |
| `SNITCH_GITHUB_AUTO_CREATE` | `false` | Create a member for an unknown GitHub user. Needs `SNITCH_GITHUB_ALLOWED_ORG`. |
| `SNITCH_GITHUB_WEB_URL` / `_API_URL` | `https://github.com` / `https://api.github.com` | For GitHub Enterprise Server: `https://ghe.example.com` and `https://ghe.example.com/api/v3`. |
| `SNITCH_TRUST_PROXY` | `none` | Which header carries the client IP: `xff`, `fly`, `cloudflare`. Only set it behind that proxy. |
| `SNITCH_ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow webhooks to private/loopback addresses (off to prevent SSRF). |
| `SNITCH_SESSION_DAYS` | `14` | Dashboard session lifetime (sliding). |
| `SNITCH_REPORTS_PER_KEY_PER_HOUR` | `120` | Intake rate limit per ingest key. |
| `SNITCH_REPORTS_PER_IP_PER_10_MIN` | `20` | Intake rate limit per client IP. |
| `SNITCH_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs are JSON lines on stdout/stderr. |

## The CLI

Inside the container the `snitch` admin command is on the `PATH`. (For reading tickets from your own machine or a
coding agent, see the [snitch CLI and MCP server](cli.md) instead.)

```sh
docker exec snitch snitch user:create --email you@example.com --password '…' --role admin
docker exec snitch snitch user:reset-password --email you@example.com --password '…'
docker exec snitch snitch project:create --name Mochiro --slug mochiro --prefix MOCH [--ingest-key snitch_pk_…]
docker exec snitch snitch key:create --project mochiro --label "Release builds"
docker exec snitch snitch backup --out /data/backup-$(date +%F).db
```

`project:create --ingest-key` lets you pick the key up front, so an app can be built with it before the server exists.

## Triage in bulk

In the inbox, tick tickets (or press <kbd>x</kbd> on the highlighted one; the checkbox above the list selects every
loaded ticket) to assign them, move them to a status, escalate them or delete them together. Escalating needs the
tickets to be from one project, since integrations belong to a project; tickets already escalated there are skipped.
Deleting is for admins and removes the media for good. Assigning more than three tickets at once sends the assignee one
email listing them instead of one each.

## Escalation

Integrations are configured per project in the dashboard (**Settings → Integrations**):

- **GitHub**: a fine-grained personal access token restricted to the target repository with *Issues: Read and write*
  (plus *Contents: Read and write* when the media goes into the repository; see below).
  The issue body contains the description, the screenshot, the video, a device table, what happened just before
  the report (errors and failed requests from the timeline) and a link to the ticket. See
  [Media in GitHub issues](#media-in-github-issues).
- **Email**: needs `SNITCH_SMTP_URL`. The screenshot is attached inline, and the video is linked.
- **Webhook**: `slack` (incoming webhook), `discord`, or `generic` JSON. Generic payloads are signed:
  `X-Snitch-Signature: sha256=HMAC_SHA256(secret, "<X-Snitch-Timestamp>.<raw body>")`.

**Routing** rules map a report type (or any type) to an integration, either *automatically* (sent as soon as the
report finishes uploading) or as a *suggestion* highlighted on the ticket. Failed sends retry with exponential backoff.
After 8 attempts, or immediately for permanent errors such as a revoked token, they show as failed on the ticket and in
**Jobs**, where they can be retried by hand.

When a report carries a timeline (SDK 0.3), GitHub issues and emails get a short **Before the report** section: the
screen the tester was on, and the last ten error log lines and failed requests, one line each. The full timeline stays in
the dashboard.

### Media in GitHub issues

GitHub has no API for issue attachments, so each GitHub integration picks one of three ways to show the screenshot and
video (**Settings → Integrations → Edit**):

- **Committed to the repository** (the default for new integrations). Snitch commits the report's screenshot, video,
  timeline and logs to the `snitch-media` branch under the ticket's key (`MOCH-42/screenshot.jpg`), one commit per
  report, and the issue shows the screenshot and links the rest. GitHub only serves those files to people who can see
  the repository, so a private repo keeps them private, and someone reading the issue (or an agent working on it)
  needs nothing from Snitch. The token needs *Contents: Read and write* as well. Things to know:
  - The files stay in the branch's history; deleting a ticket in Snitch doesn't remove them. Delete the branch to
    purge everything.
  - A plain `git clone` downloads every branch, so the media adds to every full clone of the repo (CI checkouts of one
    branch are unaffected). To avoid that, set *Keep them in another repository* to a separate (private) repo the
    token can write to; the issue links there instead.
  - If the commit is refused (no *Contents* permission, an empty repository), the issue is still created, says the
    media is in Snitch, and the ticket records why.
- **Public links**: expiring Snitch share links (30 days). Anyone with a link can open it, and GitHub's image proxy
  caches the screenshot.
- **Not included**: the issue says the media is in Snitch.

Integrations created before 0.4 keep what they had: public links if *Include public links* was ticked, otherwise not
included.

### GitHub two-way sync

Two switches on a GitHub integration keep a ticket and its issue in step:

- **Sync status**: resolving a ticket closes the issue (as *completed*); *won't fix* and *duplicate* close it as
  *not planned*; reopening the ticket reopens the issue. In the other direction, an issue closed on GitHub resolves the
  ticket (*won't fix* when closed as not planned) and a reopened issue moves it back to *triaged*. A ticket that is
  already closed (or already open) is left as it is.
- **Sync comments**: comments written in Snitch are posted to the issue as "**Name** commented in Snitch", and new
  issue comments show up on the ticket.

Changes from Snitch need nothing more than the token (*Issues: Read and write*). Changes from GitHub need a webhook:

1. In Snitch, open the GitHub integration's settings and create a webhook secret (admins only). Copy the payload URL
   (`https://snitch.example.com/api/hooks/github/<integration id>`) and the secret; the secret is shown once.
2. In the GitHub repository: **Settings → Webhooks → Add webhook**.
   - Payload URL: the URL from step 1.
   - Content type: `application/json`.
   - Secret: the secret from step 1.
   - Events: **Let me select individual events** → tick **Issues**, **Issue comments** and **Pull requests** (untick
     *Pushes*).
3. Save. GitHub sends a ping, which Snitch answers with `204`; **Recent Deliveries** shows what Snitch did with each
   later event.

Deliveries without a valid `X-Hub-Signature-256` are refused. Creating a new secret replaces the old one immediately, so
paste it into GitHub right away. Snitch never re-imports what it posted itself, so nothing loops.

With **Pull requests** ticked, a pull request that says it fixes the issue (`Fixes #123` and GitHub's other closing
keywords) is recorded on the ticket when it's opened, merged or closed. That needs neither switch, and changes no
status: merging closes the issue, and **Sync status** takes it from there.

## Notifications

Two switches in each project's settings; both need `SNITCH_SMTP_URL`:

- **Email assignees** (on by default): when someone assigns a ticket to another member, that member gets an email with
  a link to the ticket.
- **Email reporters** (off by default): when a ticket is resolved and the tester left an email address in the app,
  they get a short thank-you with the ticket key, its title and, when set, the build it's fixed in (**Fixed in** on the
  ticket). Nothing else goes out: no comments, no links into the dashboard.

Each email that goes out, or fails for good after its retries, is noted on the ticket. Without SMTP the messages are only
written to the log.

## Devices

SDKs from 0.3 identify their install with a random id (not derived from the device) when they fetch the remote config.
The project's **Devices** page lists those installs: app version and build, the release type the SDK detected and the
signals behind it, OS, model, whether Snitch was enabled for it, and how many reports it sent. Per build it shows how
many installs checked in, by release type, so a build whose SDK never came up (wrong release type, missing key) stands
out. Installs not seen for 180 days are forgotten.

## Team, invites and passwords

Admins add people under **Team**. By default that sends an invite: an email with a link to choose their own password,
which works once, for 7 days (**Resend invite** replaces it). Untick **Email them an invite** to set a temporary password
instead.

Anyone can use **Forgot password?** on the sign-in page to get a reset link (valid for 1 hour, at most three emails per
address an hour). The page answers the same whether or not the address has an account. Admins can also send someone a
reset link from **Team → Reset password**; that one lasts 24 hours. Using a link signs out every other session of that
user and revokes their [API tokens](cli.md#api-tokens).

All of this needs `SNITCH_SMTP_URL`. Without it the sign-in page tells people to ask an admin, and the dashboard shows the
admin each invite or reset link to pass on themselves. Only the SHA-256 of a link's token is stored.

## API tokens and the snitch CLI

Everyone has an **API tokens** page for personal tokens (`tickets:read`, `tickets:write`) used by the
[snitch CLI](cli.md), its MCP server for coding agents, and scripts. `snitch login` makes one through device sign-in:
the terminal shows a code, and the user approves it on the dashboard's `/device` page. Tokens can't manage users,
projects, integrations or other tokens. Disabling a person or resetting their password revokes theirs. Writes made with a token are audited as
`api_token.write`.

## Sign in with GitHub

Besides email and password, people can sign in with their GitHub account:

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App** (under your organization's settings if the
   org should own it).
   - Homepage URL: your `SNITCH_PUBLIC_URL`.
   - Authorization callback URL: `<SNITCH_PUBLIC_URL>/api/admin/auth/github/callback`.
2. Generate a client secret and set `SNITCH_GITHUB_CLIENT_ID` and `SNITCH_GITHUB_CLIENT_SECRET`. The login page now
   offers **Sign in with GitHub**.

Who gets in:

- A user whose email (in **Team**) is one of the GitHub account's *verified* addresses. The first sign-in links the
  GitHub account to that user; later sign-ins go by the link.
- With `SNITCH_GITHUB_ALLOWED_ORG`, every GitHub sign-in also needs an active membership of that organization (the app
  then asks for `read:org`). If the organization restricts third-party OAuth apps, an owner has to approve the app.
- Nobody else, unless `SNITCH_GITHUB_AUTO_CREATE=true` *and* an organization is set: then members of the organization
  without a Snitch account are created as members on their first sign-in.
- Disabled users never.

Sign-in attempts count against the same per-address limit as password sign-in. GitHub's token is only used during the
sign-in and is never stored.

## Operations

- **Backups**: see [Backups](#backups) below.
- **Uploads**: SDKs from 0.3 upload large attachments in chunks and resume where they stopped
  (`SNITCH_UPLOAD_CHUNK_BYTES`). Chunks in progress live in `<data>/tmp/partial/`; uploads abandoned for 24 hours are
  cleaned up with their report.
- **Upgrades**: pull the new image and restart. Migrations run on boot, are ordered, and can skip versions.
  A database written by a newer server refuses to open on an older one instead of being damaged.
- **Health**: `GET /health` (liveness) and `GET /health/ready` (database and storage writable). The Fly example checks
  `/health/ready`, the Docker image's `HEALTHCHECK` uses `/health`.
- **Scaling**: one instance. Rate limits and the worker live in-process. That's plenty for a QA team: reports are
  rare, small, and stored on disk.
- **Security model**: ingest keys ship inside your app, so treat them as public. They can only create reports
  for one project, are rate limited, and can be revoked. The server also refuses reports from release types and app
  ids a project doesn't accept. Dashboard sessions are HttpOnly cookies with CSRF tokens. Uploaded files are served
  with `nosniff` and a sandboxing CSP, never as HTML.

### Backups

Set `SNITCH_BACKUP_INTERVAL_HOURS` (for example `24`) and the server backs its database up by itself: an online SQLite
backup (the server keeps serving), gzipped, uploaded as `snitch-<UTC time>.db.gz` (for example
`snitch-20261013T000000Z.db.gz`), with the newest `SNITCH_BACKUP_KEEP` kept. Backups run at the start of each interval
(UTC) and right after the feature is turned on. The last backup and the last error are part of the server info the
dashboard shows (`GET /api/admin/server`).

Where they go:

- **A separate bucket (recommended)**: set `SNITCH_BACKUP_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY` (and `_REGION`, `_PREFIX` as needed). Use a bucket at another provider or in another region than
  the server, so losing one doesn't lose both.
- **Otherwise** they go to the attachment store under `backups/`: your S3 bucket with `SNITCH_STORAGE=s3`, or
  `<data>/blobs/backups/` on the data volume, which protects against a corrupted database but not against losing the
  volume.

Backups cover the database (tickets, comments, settings, users). Attachments are already in the blob store: back up
`<data>/blobs` or replicate your bucket. For a one-off copy, `snitch backup --out /data/backup.db` still works.

To restore, stop the server, `gunzip` a backup to `<data>/snitch.db`, delete `snitch.db-wal` and `snitch.db-shm` next to
it if present, and start the server. A backup from an older version is migrated on boot.
