# NODEBASE

**A self-hosted Discord bot workspace and private file cloud.** NODEBASE is designed for one administrator on one VPS, with a React dashboard, a Fastify API, SQLite metadata, private disk-backed file objects, and a separate authenticated Docker runner.

> **Deployment status:** This repository is a fresh implementation. It has not been deployed to your VPS from this workspace. Run the build and test steps below, then deploy through your existing Coolify instance. The bot runner requires Docker socket access on the host and is deliberately kept on a private Compose network.

## V2 development status

The branch `feat/nodebase-v2-foundation` introduces a first multi-node connectivity slice while preserving the existing V1 flow:

- Add a Hosting Nodes section to the mobile-responsive panel.
- Issue 15-minute, single-use enrollment tokens for authenticated administrators.
- Enroll a remote node agent over HTTPS and exchange the enrollment secret for a unique credential.
- Store only hashes of enrollment and node credentials on the control plane.
- Report node heartbeats and real host CPU, memory, disk, and declared runtime telemetry.
- Mark nodes offline when heartbeats are older than 90 seconds; expose drain, re-enable, and credential-revoke controls.

This is an incremental foundation, not a claim that remote bot lifecycle scheduling is complete. The node agent currently reports connectivity and telemetry. Remote bot container creation, command acknowledgements, remote logs, and placement/scheduling remain future work. See [`docs/V2-ARCHITECTURE.md`](docs/V2-ARCHITECTURE.md) for the current scope and agent installation guide.

## Included in this MVP

- First-run admin setup protected by `NODEBASE_SETUP_KEY`; no default account, no public registration.
- Scrypt password hashes, expiring HTTP-only session cookies, CSRF double-submit protection, login rate limiting, security headers, and server-side authorization.
- Overview dashboard, real host/container metrics where available, recent activity, and a responsive light-mode workspace with a dark theme option.
- Python and Node.js bot project creation/import from ZIP; safe extraction filters traversal, ZIP symlinks, private environment files and common private-key files.
- A separately authenticated runner with Docker lifecycle, status, logs, CPU/RAM reporting and resource limits. No host shell endpoint and no published bot ports.
- General private File Cloud: streamed uploads, per-file and total-storage limits, folders, nested breadcrumbs, search/sorting, list/grid presentation, download/preview, rename, move, copy, delete, bulk delete, upload queue/history, and storage usage.
- Bot workspace settings, encrypted environment values, startup configuration, logs, controlled backups, restore, activity and account/session settings.
- Docker multi-stage build and Compose configuration suitable for a new Coolify Compose resource.

## Architecture

```text
Browser (HTTPS via Coolify)
    │ same-origin API + UI
    ▼
NODEBASE panel (React build + Fastify API, non-root)
    ├── SQLite + private blob storage + bot workspaces + backups (persistent host directory)
    └── authenticated private HTTP ──► NODEBASE runner (separate container)
                                           │ Docker socket, restricted API only
                                           ▼
                                      per-bot containers
```

The Docker socket is mounted **only** into the runner, not the browser-facing API. The runner API is not published to the host and lives on a Compose network marked `internal`. Each bot gets its own bridge network, no published ports, a read-only source mount, a read-only container root filesystem, dropped Linux capabilities, `no-new-privileges`, CPU/RAM/PID limits, and a non-root runtime user.

**Security boundary to understand:** the Docker socket is highly privileged even when its caller is a separate service. Treat the runner image and its token as part of the host's trusted computing base. Bot containers can make outbound network requests so Discord APIs work; this MVP does not enforce a Discord-only egress allowlist. Apply host firewall/egress controls if your threat model requires blocking access to the VPS host, private LAN ranges, or other destinations. Do not run arbitrary/untrusted users' bots on a sensitive host without additional isolation.

## Requirements

- Docker Engine and Docker Compose plugin on the VPS.
- A working existing Coolify installation.
- Node.js 22 + npm 10 for local development, or the supplied Dockerfile for image builds.
- A dedicated, persistent host path for NODEBASE data. The default is `/srv/nodebase/data`; it must resolve to the **same absolute path on the host, panel container and runner container** because Docker bind-mounts bot workspace paths on the host.
- HTTPS in front of the panel in production.

This application does not modify Coolify's own databases or configuration. Do not point NODEBASE storage to `/data/coolify` or a directory used by any existing service.

## Quick local development

```bash
cp .env.example .env
# Replace every placeholder using fresh random values; see Secret generation below.
npm install
npm run dev
```

The Vite UI runs on `http://localhost:5173` and proxies `/api` to `http://127.0.0.1:3001`. Start the API and runner separately if you are not using the root `dev` script:

```bash
npm run dev -w backend
npm run dev -w frontend
npm run dev -w runner
```

For file cloud and auth testing, the API can run without a connected runner; bot lifecycle actions should clearly report that the runner is unavailable. Running bot containers requires a reachable Docker socket and a configured runner.

## Secret generation

Never reuse an example placeholder. Generate distinct secrets on the VPS (or a trusted local machine):

```bash
printf 'NODEBASE_SETUP_KEY='; openssl rand -hex 32
printf 'NODEBASE_ENCRYPTION_KEY='; openssl rand -base64 32
printf 'RUNNER_TOKEN='; openssl rand -hex 32
stat -c 'DOCKER_GID=%g' /var/run/docker.sock
```

Set the generated values as environment variables in Coolify, not in Git. **Keep `NODEBASE_ENCRYPTION_KEY` stable** after saving environment variables; changing it makes previously encrypted bot environment values unreadable. Keep `RUNNER_TOKEN` identical for the panel and runner. After the initial admin is created, the setup endpoint refuses any further setup requests, but leave the configured setup key in the environment because production configuration validation requires a strong value.

## Deploy using your existing Coolify

### 1. Put this project in a repository

Upload/commit the contents of this folder to a Git repository you control. Do not commit `.env`, real secrets, SQLite databases, uploaded files, or bot tokens. The included `.gitignore` excludes environment files, build output, and SQLite data.

### 2. Prepare an isolated persistent data directory

On the VPS, first confirm `/srv/nodebase/data` is not already used by another service. Use a **new dedicated directory**. The application containers run as UID 1000; create the directory with ownership suitable for that UID. Example for a new path only:

```bash
sudo install -d -o 1000 -g 1000 -m 0750 \
  /srv/nodebase/data \
  /srv/nodebase/data/db \
  /srv/nodebase/data/bots \
  /srv/nodebase/data/file-blobs \
  /srv/nodebase/data/backups \
  /srv/nodebase/data/tmp
stat -c '%U:%G %a %n' /srv/nodebase/data /srv/nodebase/data/db
```

If you choose another path, set `NODEBASE_HOST_DATA_ROOT` in Coolify to that absolute path. The host path, `NODEBASE_STORAGE_ROOT`, `NODEBASE_DATABASE_PATH`, `NODEBASE_BOT_ROOT`, `NODEBASE_BLOB_ROOT`, `NODEBASE_BACKUP_ROOT`, and `WORKSPACE_ROOT` must line up with the Compose file. Do not run a recursive `chown` against an existing directory unless you have verified it contains no unrelated user data.

### 3. Read the Docker socket group ID

```bash
stat -c '%g' /var/run/docker.sock
```

Set the printed numeric value as `DOCKER_GID` in Coolify. If the runner health check reports Docker access denied, verify the socket's group and mode (`stat -c '%A %U:%G %n' /var/run/docker.sock`) and correct `DOCKER_GID`. Do not make the Docker socket world-writable.

### 4. Create the Coolify application

1. In Coolify, create a **new Docker Compose resource** from your Git repository. Keep it separate from existing Coolify services.
2. Select `docker-compose.yml` as the Compose file.
3. Configure these environment variables in Coolify:
   - `NODEBASE_SETUP_KEY` — random value generated above (32+ chars).
   - `NODEBASE_ENCRYPTION_KEY` — output of `openssl rand -base64 32`.
   - `RUNNER_TOKEN` — a different random value, 32+ chars.
   - `DOCKER_GID` — numeric Docker socket group ID.
   - `NODEBASE_HOST_DATA_ROOT` — dedicated persistent host path (default `/srv/nodebase/data`).
   - `FRONTEND_ORIGIN` — the exact panel origin, e.g. `https://nodebase.example.com` (no trailing slash). This is required to allow same-origin browser requests with strict CORS.
   - Optionally set `NODEBASE_MAX_FILE_BYTES`, `NODEBASE_MAX_STORAGE_BYTES`, `NODEBASE_MAX_BOT_ZIP_BYTES`, `BOT_MEMORY_MB`, `BOT_CPU_NANOS`, and `NODEBASE_SESSION_DAYS`.
4. The Compose file exposes port `3001` for the panel service and exposes runner port `3099` **only within the private Compose network**. Do not attach a public domain or public port to the runner.
5. Assign your HTTPS domain to the **panel** service and target internal port `3001`. Let Coolify handle the TLS certificate/reverse proxy. Keep `NODE_ENV=production` and `TRUST_PROXY=true` as supplied by the Compose file.
6. Deploy. Watch the build and health-check output in Coolify. Initial builds need access to the npm registry and bot image pulls need access to the container registry.

### 5. First sign-in

Open the HTTPS panel domain. On first run, enter `NODEBASE_SETUP_KEY` and create the administrator. Use a strong password of 12 or more characters. Store the password safely. The app does not create a default account. After the admin is created, setup is disabled by database state.

### 6. Confirm health

From the VPS, test the health endpoint (substitute your domain):

```bash
curl -fsS https://YOUR_DOMAIN/api/health
```

The panel Settings → Server & services page reports whether the database, encryption key, and runner are configured. A runner connection is only considered healthy if the runner can reach Docker; a running HTTP process without Docker access is not enough.

### 7. First bot test

Use a harmless test project (for example, a bot that logs a message then exits) before importing an important bot. Import its ZIP, inspect the detected runtime/entry point, deploy it, check the console logs, and verify stop/restart. Bot containers require image pulls and optional dependency installation, so the initial deployment can take longer than later starts.

## Environment variables

| Variable | Purpose | Default / requirement |
|---|---|---|
| `NODEBASE_SETUP_KEY` | One-time first-admin setup guard | Required in production, 32+ random characters |
| `NODEBASE_ENCRYPTION_KEY` | AES-256-GCM encryption for bot env vars | Required in production, base64 for exactly 32 bytes |
| `RUNNER_TOKEN` | Panel-to-runner bearer token | Same strong random value in both services |
| `NODEBASE_HOST_DATA_ROOT` | Host bind-mount root | `/srv/nodebase/data`; must be dedicated and persistent |
| `NODEBASE_STORAGE_ROOT` | App data root inside panel | Set from host root by Compose |
| `NODEBASE_DATABASE_PATH` | SQLite DB path | `.../db/nodebase.sqlite` |
| `NODEBASE_BOT_ROOT` | Bot project root | `.../bots` |
| `NODEBASE_BLOB_ROOT` | Private file objects | `.../file-blobs` |
| `NODEBASE_BACKUP_ROOT` | Backup archives | `.../backups` |
| `NODEBASE_MAX_FILE_BYTES` | Maximum individual File Cloud upload | `1073741824` (1 GiB) |
| `NODEBASE_MAX_STORAGE_BYTES` | Total File Cloud metadata-tracked storage cap | `107374182400` (100 GiB) |
| `NODEBASE_MAX_BOT_ZIP_BYTES` | Maximum uploaded bot ZIP | `262144000` (250 MiB) |
| `NODEBASE_SESSION_DAYS` | Max session lifetime | `7`, range 1–90 |
| `DOCKER_GID` | Docker socket group ID for runner | Read from socket with `stat` |
| `BOT_MEMORY_MB` | Per-bot memory limit | `512`, runner clamps 256–4096 |
| `BOT_CPU_NANOS` | Per-bot CPU quota | `500000000` (about 0.5 CPU) |
| `FRONTEND_ORIGIN` | Allowed panel browser origin for strict CORS | Required in Coolify; exact `https://YOUR_DOMAIN`, no trailing slash |
| `TRUST_PROXY` | Trust Coolify reverse proxy headers | `true` in Compose; use only behind trusted proxy |
| `LOG_LEVEL` | App log level | `info` |

## Build, test and checks

```bash
npm run typecheck
npm run build
npm test
```

Critical API and filesystem tests live in `backend/test`. Runner path/policy tests live in `runner/test`. The test scripts use a dedicated temporary folder under `/tmp/nodebase-test-storage` and are not intended to be run against production data.

If npm cannot download packages on the machine where you are running these commands, repeat them on the VPS/Coolify build environment with registry access. Do not treat a syntax-only check as a successful production build.

## Operations and limitations

- The File Cloud is private: all file listing, downloads, previews, and mutations require an authenticated session. It does not publish public links.
- Uploads are streamed to opaque object IDs on disk, while SQLite stores metadata. File Cloud usage is calculated from recorded files; do not manually edit/delete blobs behind the application.
- ZIP bot imports exclude `.env`, most `.env.*` files, private-key extensions and symlinks; create secrets in the Environment tab instead. Backups also omit `.env` files and common dependency/build directories.
- The runner supports Python and Node images, basic dependency detection (`requirements.txt`, `package.json`), startup commands, restart policy, logs, status and resource stats. Some bots need native build tools, a specific runtime version, unusual OS libraries, or ports; those requirements need explicit implementation before running such projects.
- Bot source editing is not a general code editor in this MVP. Bot files can be browsed/downloaded, and startup/environment configuration can be managed in the panel.
- No billing, public registration, multi-user tenancy, public file sharing, or payment processing is included.
- A backup restore requires a healthy runner if a container may exist; the API stops the bot before replacing source files.
- Back up the persistent data directory using a trusted host-level backup process before upgrading the app or changing secrets.

## Troubleshooting

**Setup page says the key is not configured:** set `NODEBASE_SETUP_KEY` in Coolify, with 32+ random characters; redeploy.

**Production service exits at boot:** review the panel or runner logs. Production rejects placeholder/weak setup keys, missing or invalid encryption keys, and weak runner tokens.

**Runner offline / Docker unavailable:** check the runner logs, `DOCKER_GID`, `/var/run/docker.sock` ownership/mode, and that `RUNNER_TOKEN` matches in both services. The runner must not be assigned a public domain.

**Upload fails with 413:** lower the file size or increase `NODEBASE_MAX_FILE_BYTES` only if you have sufficient disk and the reverse proxy permits the request size.

**File Cloud appears empty after redeploy:** verify `NODEBASE_HOST_DATA_ROOT` still points to the same host directory and that all expected path variables still match. Never start a new deployment against a different empty path when you expect old files.

**Bot builds but exits:** inspect logs; check entry point, runtime, environment, and dependencies. The console command input is a small allowlist (`help`, `status`, `restart`), not a host shell.

## Security notes

Review [`docs/runner-hardening.md`](docs/runner-hardening.md) before exposing this on the internet. Security checks reduce risk, but do not make arbitrary uploaded code intrinsically safe. Keep host OS and Docker updated, use HTTPS, protect secrets, limit access to the admin, and maintain off-host backups.
