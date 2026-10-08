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
| `SNITCH_SMTP_URL` | — | `smtp://user:pass@host:587` or `smtps://…:465`. Without it, email escalations fail with a clear error. |
| `SNITCH_MAIL_FROM` | `Snitch <snitch@localhost>` | Sender for escalation emails. |
| `SNITCH_STORAGE` | `fs` | `fs` (data volume) or `s3`. |
| `SNITCH_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE` | — / `auto` / `true` | Any S3-compatible store (AWS, Cloudflare R2, SeaweedFS, Garage). |
| `SNITCH_RETENTION_DAYS` | `90` | Tickets older than this are deleted with their media. `0` keeps everything. Projects can override. |
| `SNITCH_TRUST_PROXY` | `none` | Which header carries the client IP: `xff`, `fly`, `cloudflare`. Only set it behind that proxy. |
| `SNITCH_ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow webhooks to private/loopback addresses (off to prevent SSRF). |
| `SNITCH_SESSION_DAYS` | `14` | Dashboard session lifetime (sliding). |
| `SNITCH_REPORTS_PER_KEY_PER_HOUR` | `120` | Intake rate limit per ingest key. |
| `SNITCH_REPORTS_PER_IP_PER_10_MIN` | `20` | Intake rate limit per client IP. |
| `SNITCH_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs are JSON lines on stdout/stderr. |

## The CLI

Inside the container the `snitch` command is on the `PATH`:

```sh
docker exec snitch snitch user:create --email you@example.com --password '…' --role admin
docker exec snitch snitch user:reset-password --email you@example.com --password '…'
docker exec snitch snitch project:create --name Mochiro --slug mochiro --prefix MOCH [--ingest-key snitch_pk_…]
docker exec snitch snitch key:create --project mochiro --label "Release builds"
docker exec snitch snitch backup --out /data/backup-$(date +%F).db
```

`project:create --ingest-key` lets you pick the key up front, so an app can be built with it before the server exists.

## Escalation

Integrations are configured per project in the dashboard (**Settings → Integrations**):

- **GitHub**: a fine-grained personal access token restricted to the target repository with *Issues: Read and write*.
  The issue body contains the description, a device table and a link to the ticket. GitHub has no attachment API;
  tick *Include public links* to embed the screenshot and link the video through expiring share links. That option
  is off by default because GitHub caches images and your reports may show personal data.
- **Email**: needs `SNITCH_SMTP_URL`. The screenshot is attached inline, and the video is linked.
- **Webhook**: `slack` (incoming webhook), `discord`, or `generic` JSON. Generic payloads are signed:
  `X-Snitch-Signature: sha256=HMAC_SHA256(secret, "<X-Snitch-Timestamp>.<raw body>")`.

**Routing** rules map a report type (or any type) to an integration, either *automatically* (sent as soon as the
report finishes uploading) or as a *suggestion* highlighted on the ticket. Failed sends retry with exponential backoff.
After 8 attempts, or immediately for permanent errors such as a revoked token, they show as failed on the ticket and in
**Jobs**, where they can be retried by hand.

## Operations

- **Backups**: `snitch backup --out …` writes a consistent copy of the database. Back up `<data>/blobs` (or your
  bucket) alongside it. On Fly, volume snapshots run daily.
- **Upgrades**: pull the new image and restart. Migrations run on boot, are ordered, and can skip versions.
  A database written by a newer server refuses to open on an older one instead of being damaged.
- **Health**: `GET /health` (liveness) and `GET /health/ready` (database and storage writable).
- **Scaling**: one instance. Rate limits and the worker live in-process. That's plenty for a QA team: reports are
  rare, small, and stored on disk.
- **Security model**: ingest keys ship inside your app, so treat them as public. They can only create reports
  for one project, are rate limited, and can be revoked. The server also refuses reports from release types and app
  ids a project doesn't accept. Dashboard sessions are HttpOnly cookies with CSRF tokens. Uploaded files are served
  with `nosniff` and a sandboxing CSP, never as HTML.
