# OnlineWiki — Quick Start Guide

A lightweight, self-hosted internal collaborative wiki.

## Features

- 📝 **WYSIWYG editing** — TinyMCE 7 with dark theme, tables, code blocks, and more
- 🔐 **AD/LDAP authentication** — login with Active Directory credentials via `ldapauth-fork`
- 📁 **Flat-file storage** — pages saved as JSON in `<DATA_DIR>/pages/` (configurable single sync root), no database required
- 📎 **Document uploads** — attach PDF, Word, Excel, PowerPoint and other files; download to view
- 🔍 **Live search** — filter pages and uploads instantly in the browser
- 🌙 **Premium dark UI** — glassmorphism login, animated sidebar, responsive layout

---

## Deployment Overview

| Path | Use case | DATA_DIR location | SyncThing share |
|---|---|---|---|
| **★ Docker (recommended for production)** | Multi-server HA, LB, easy upgrades | External persistent volume (`/var/lib/onlinewiki` mounted from host or named volume) | **Only DATA_DIR** (TEMPLATE B in `.stignore`) — code ships inside the image, only state is replicated |
| Bare-metal / local dev | Single server, local testing, quick iteration | Relative `data/` inside repo OR absolute path | DATA_DIR only (TEMPLATE B) OR whole repo (TEMPLATE A, legacy) |

All persistent state (pages, uploads, avatars, sessions, users, settings) lives in **one folder, DATA_DIR**. In Docker deployments, this folder is mounted from **outside the container** so that rebuilding the image never destroys your data, and SyncThing running on the host (or as a sibling container) replicates it between nodes.

---

## ★ Docker Deployment (Recommended for Production)

### 1. Prepare the environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in the required values. The defaults in `.env.example` are already tuned for Docker:

```env
# ── Docker-mounted persistent storage (already the default in .env.example)
DATA_DIR=/var/lib/onlinewiki   # container-side path — mount a host dir / named volume here
LOG_DIR=/var/log/onlinewiki    # container-side path — optional second volume

# ── Session sharing across containers (identical on every node)
SESSION_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
SESSION_MODE=syncthing         # data is replicated by SyncThing via the shared DATA_DIR volume
MAINTENANCE_TOKEN=<generate:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">

# ── LDAP / Active Directory
LDAP_URL=ldap://your-domain-controller.example.com
LDAP_BIND_DN=cn=svc-wiki,ou=ServiceAccounts,dc=example,dc=com
LDAP_BIND_PASSWORD=your-service-account-password
LDAP_BASE_DN=dc=example,dc=com
```

> **Tip:** Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` in `.env` if your domain controller uses a self-signed certificate.

### 2. Example Dockerfile

```dockerfile
# Dockerfile for OnlineWiki
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Default port (override with -e PORT= if needed)
EXPOSE 3000

# ⚠ IMPORTANT: Do NOT declare a VOLUME here — volumes are declared in docker-compose.yml
# or with `docker run -v` so you control the host-side path (needed for SyncThing to
# replicate the same DATA_DIR across nodes consistently).

CMD ["npm", "start"]
```

### 3. Example docker-compose.yml (single node)

```yaml
# docker-compose.yml — deploy to every server that runs OnlineWiki + SyncThing
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      # ★ PERSISTENT STORAGE — map the container's DATA_DIR to an EXTERNAL location.
      # Use a NAMED VOLUME for a single server; for multi-server SyncThing replication,
      # use a HOST BIND-MOUNT (see below) so the host-side SyncThing daemon can read it.
      - onlinewiki_data:/var/lib/onlinewiki
      # Optional: mount logs out if you want them on the host for log collectors
      - onlinewiki_logs:/var/log/onlinewiki

volumes:
  onlinewiki_data:     # OR replace with a bind mount: /data/onlinewiki:/var/lib/onlinewiki
  onlinewiki_logs:
```

### 4. Multi-server SyncThing replication (Docker)

For a load-balanced, multi-server deployment with SyncThing-replicated DATA_DIR:

1. **On every server**, create a host directory that SyncThing will replicate, and map it as a **bind-mount** (not a named Docker volume):

```yaml
# docker-compose.yml — multi-server variant, SAME on every node
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      # ★ HOST BIND-MOUNT: SyncThing on the host replicates this directory.
      # The container-side path /var/lib/onlinewiki stays identical on every server,
      # which keeps env configs identical across nodes.
      - /data/onlinewiki:/var/lib/onlinewiki
      - /var/log/onlinewiki:/var/log/onlinewiki
```

2. **Start the stack on every node:**
   ```bash
   docker compose up -d --build
   ```

3. **Set up SyncThing (host or sibling container) to sync ONLY the DATA_DIR folder:**
   - On every node, point SyncThing at the **host-side** directory (e.g. `/data/onlinewiki`).
   - Copy **TEMPLATE B** (the DATA_DIR-only template) from [`.stignore`](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/.stignore#L30-L65) into `<host-DATA_DIR>/.stignore` (e.g. `/data/onlinewiki/.stignore`).
   - This is the **default/recommended** template. It ignores transient `sessions/*.tmp`, `sessions/*.lock`, and any stray `logs/`; everything else (pages, uploads, avatars, `sessions/*.json`, `users.json`, `settings.json`) is replicated.

4. **Enable sticky sessions** on your load balancer (same rules as bare-metal — see the Multi-Server section below).

5. **Run ONE global session reaper** across the cluster (exactly one scheduled task, hitting any node's `POST /api/maintenance/expire-sessions` with `MAINTENANCE_TOKEN`).

---

## Alternative: Bare-metal / Local Dev Setup (npm start)

Use this for single-server installs or local development on a Windows / Linux machine with Node.js installed.

### 1. Copy environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in your Active Directory details. For bare-metal you can keep `DATA_DIR=data` (inside the repo) or point it at a mapped drive / UNC:

```env
# For bare-metal you can keep these defaults or switch to absolute paths:
DATA_DIR=data
LOG_DIR=logs

SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

LDAP_URL=ldap://your-domain-controller.example.com
LDAP_BIND_DN=cn=svc-wiki,ou=ServiceAccounts,dc=example,dc=com
LDAP_BIND_PASSWORD=your-service-account-password
LDAP_BASE_DN=dc=example,dc=com
```

> **Tip:** Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` in `.env` if your domain controller uses a self-signed certificate.

### 2. Install dependencies

```powershell
npm install
```

### 3. Start the server

```powershell
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

The wiki will be available at **http://localhost:3000** (or the `PORT` from `.env`).

---

## Project Structure

```
OnlineWiki/                             ← application code (ships inside Docker image; NOT synced by SyncThing)
├── server.js           — Express app, routes, LDAP auth
├── .env                — Your configuration (never commit this; passed to container via --env-file)
├── .env.example        — Config template (Docker-friendly defaults: DATA_DIR=/var/lib/onlinewiki)
├── views/
│   ├── layout.ejs      — Shared shell (sidebar, topbar)
│   ├── login.ejs       — AD login form
│   ├── home.ejs        — Page list with search
│   ├── page.ejs        — Page reader
│   ├── edit.ejs        — TinyMCE editor
│   ├── uploads.ejs     — Document manager
│   └── error.ejs       — Error pages
├── public/
│   ├── css/style.css   — Premium dark-mode CSS
│   └── js/
│       ├── app.js      — Sidebar, search, shared UI
│       └── editor.js   — TinyMCE init + slug + attachment picker
├── lib/
│   └── logger.js       — Winston logger setup (reads LOG_DIR env)
├── test_files/         — Local test fixtures / scratch data (never commit or sync)
│
├── <DATA_DIR>/         — ★ Consolidated persistent storage — the ONLY folder SyncThing replicates
│   │                      Docker default: /var/lib/onlinewiki (mounted as external volume).
│   │                      Bare-metal default: data/ (relative inside repo).
│   ├── pages/          — Wiki pages stored as .json files
│   ├── uploads/        — Uploaded documents
│   ├── avatars/        — User profile avatars (circular PNGs)
│   ├── sessions/       — Session JSON files (SESSION_MODE=syncthing shares these)
│   ├── users.json      — Local user registry + roles + password hashes
│   └── settings.json   — Site title / tagline / home heading
│
└── <LOG_DIR>/          — Per-instance logs (do NOT sync; LOG_DIR env)
                          Docker default: /var/log/onlinewiki.
                          Bare-metal default: logs/ (inside repo).
```

`<DATA_DIR>` is controlled by the `DATA_DIR` env var:

| Environment | Default value | How it is provisioned |
|---|---|---|
| **Docker (production)** | `/var/lib/onlinewiki` | Mounted as a **bind-mount** (SyncThing multi-server) or **named volume** (single server) from outside the container |
| Bare-metal / local dev | `data` (relative) | Created inside the repo; can be overridden to `X:\OnlineWiki-Data`, `\\filer.corp\wiki$`, or `/srv/onlinewiki-data` |

`LOG_DIR` is separate (default `/var/log/onlinewiki` in Docker, `logs` in bare-metal) and must **never** be replicated between servers.

---

## Page Storage Format

Each page is stored as `<DATA_DIR>/pages/<slug>.json`:

```json
{
  "title": "Getting Started",
  "slug": "getting-started",
  "content": "<p>HTML content from TinyMCE...</p>",
  "tags": ["setup", "onboarding"],
  "author": "jdoe",
  "authorDisplay": "Jane Doe",
  "createdAt": "2026-09-02T02:00:00.000Z",
  "updatedAt": "2026-09-02T04:00:00.000Z",
  "attachments": ["1725235200000_User_Guide.pdf"]
}
```

---

## Uploading Documents

1. Go to **Documents** in the sidebar
2. Drag & drop or click **Choose File** — supported types: PDF, Word, Excel, PowerPoint, images, ZIP, CSV (max 50 MB)
3. To attach a file to a page, open the page editor and click **Add from Uploads** in the sidebar panel
4. On the page view, attachments appear as download buttons — files must be downloaded to open

---

## LDAP Troubleshooting

| Symptom | Fix |
|---|---|
| "Authentication error" on login | Check `LDAP_URL` and `LDAP_BIND_DN`/`LDAP_BIND_PASSWORD` |
| Certificate errors | Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` |
| Wrong users found | Adjust `LDAP_SEARCH_FILTER` (default: `sAMAccountName`) |
| `ldap://` vs `ldaps://` | Use `ldaps://` for port 636 (secure LDAP) |

Check the console output for `[LDAP]` error lines when debugging auth issues.

---

## Multi-Server Deployment with SyncThing

The wiki is designed to run on multiple servers simultaneously. **All persistent state lives inside a single configurable root folder, DATA_DIR** — point SyncThing at **THIS ONE FOLDER** on every server, and **nothing else** needs syncing. This is the default architecture. In Docker deployments, DATA_DIR is a persistent volume mounted from outside the container; in bare-metal deployments it can be a mapped drive, UNC share, or local path.

Sessions, pages, uploads, avatars, the user registry, and site settings all live inside DATA_DIR, so load-balanced users never need to re-login when the LB picks a different server.

Two env vars control storage layout. Configure them on **every** node (identical DATA_DIR, LOG_DIR can differ per server):

| Variable | Default (Docker / prod) | Sync? | Example values |
|---|---|---|---|
| `DATA_DIR` | `/var/lib/onlinewiki` | ✅ **YES — single SyncThing root (TEMPLATE B, default)** | `/var/lib/onlinewiki` (Docker bind-mount), `/data/onlinewiki` (Linux host), `X:\OnlineWiki-Data`, `\\filer.corp\wiki$`, `data` (legacy bare-metal inside repo) |
| `LOG_DIR` | `/var/log/onlinewiki` | ❌ NO — per-instance diagnostics | `/var/log/onlinewiki`, `/var/log/onlinewiki-a`, `D:\Logs\WikiA`, `logs` (legacy) |

On startup the banner prints both absolute paths — so you can verify at a glance that the nodes point at the right storage:

```
# Docker node:
Persistent data (DATA_DIR=/var/lib/onlinewiki): /var/lib/onlinewiki
Local logs        (LOG_DIR =/var/log/onlinewiki):  /var/log/onlinewiki

# Bare-metal node (legacy):
Persistent data (DATA_DIR=X:\OnlineWiki-Data):  X:\OnlineWiki-Data
Local logs        (LOG_DIR =D:\Logs\WikiA):      D:\Logs\WikiA
```

### Architecture overview

```
                      ┌──────────────────────┐
                      │  DNS / Load Balancer │
                      │  ⚠ STICKY SESSIONS   │  ← affinity: client IP or cookie
                      └──────────┬───────────┘
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
  Server A (Office 1)                    Server B (Office 2)
  ┌────────────────────────────────────────┐  ┌────────────────────────────────────────┐
  │  ┌─ Docker container ──────────────┐    │  │  ┌─ Docker container ──────────────┐    │
  │  │  node server.js              │    │  │  │  node server.js              │    │
  │  │  DATA_DIR=/var/lib/onlinewiki  │    │  │  │  DATA_DIR=/var/lib/onlinewiki  │    │  ← SAME container-side value
  │  │  LOG_DIR =/var/log/onlinewiki│    │  │  │  LOG_DIR =/var/log/onlinewiki│    │
  │  └───────┬──────────────────┬───────┘    │  │  └───────┬──────────────────┬───────┘    │
  │          ↕ bind-mount    ↕ bind-mount   │  │          ↕ bind-mount    ↕ bind-mount   │
  │  ┌───────▼──────────┐ ┌───▼───────────┐  │  │  ┌───────▼──────────┐ ┌───▼───────────┐  │
  │  │  HOST DATA_DIR   │ │  HOST LOG_DIR │  │  │  │  HOST DATA_DIR   │ │  HOST LOG_DIR │  │  ← LOG_DIRs are DIFFERENT
  │  │  /data/onlinewiki │ │ /var/log/ow  │  │  │  │  /data/onlinewiki │ │ /var/log/ow  │  │
  │  │                  │ │               │  │  │  │                  │ │               │  │
  │  │  pages/       ←────┼─┼───────────────┼──┼──┼─→  pages/          │ │               │  │
  │  │  uploads/     ←────┼─┼───────────────┼──┼──┼─→  uploads/        │ │               │  │
  │  │  avatars/     ←────┼───────────────┼──┼──┼─→  avatars/        │ │               │  │
  │  │  users.json   ←────┼─┼───────────────┼──┼──┼─→  users.json      │ │               │  │
  │  │  settings.json←────┼───────────────┼──┼──┼─→  settings.json   │ │               │  │
  │  │  sessions/*.json ←────┼───────────────┼──┼──┼─→  sessions/*.json │ │               │  │  ← SESSIONS SYNCED
  │  │                  │ │               │  │  │  │                  │ │               │  │
  │  │  reaper cron: OFF │ │               │  │  │  │  reaper cron: HOURLY│ │               │  │  ← EXACTLY ONE scheduled task
  │  └───────────────────┘ └───────────────┘  │  │  └───────────────────┘ └───────────────┘  │
  └──────────────┬────────────────────────────┘  └──────────────┬────────────────────────────┘
         ↕ SyncThing                                          ↕ SyncThing
   (SINGLE FOLDER: the HOST DATA_DIR  —  e.g. /data/onlinewiki
    Ignores sessions/*.tmp, sessions/*.lock via TEMPLATE B
    .stignore copied INTO the DATA_DIR folder root.
    Application code lives inside the Docker image — never synced by SyncThing.)
```

> **Bare-metal (legacy in-place variant): replace the Docker container layers with a plain `node server.js` process running directly on the host; DATA_DIR points directly to `X:\OnlineWiki-Data` or relative `data/`.

### Three session modes — pick one

Set `SESSION_MODE=` in `.env` on **every** server:

| Mode | `SESSION_MODE` | Sharing mechanism | Reaper strategy |
|---|---|---|---|
| Single server (default) | `single` | None — each server's DATA_DIR/sessions disk only | Built-in, hourly per node |
| **SyncThing (recommended for your LB + ST setup)** | `syncthing` | `<DATA_DIR>/sessions/*.json` replicated by SyncThing | **ONE server only** runs `POST /api/maintenance/expire-sessions` hourly via Scheduled Task/cron |
| Redis | `redis` | Redis server | Redis native TTL, no reaper needed |

All three modes keep identical `SESSION_SECRET` on every server — otherwise signed cookies can't be validated cross-instance.

---

### Setup for SyncThing session sharing (SESSION_MODE=syncthing)

**1. Deploy the application to every server**

Choose **ONE** deployment path (Docker is recommended):

```yaml
# ★ DOCKER (recommended) — repeat on every server:
#   1. Copy the project / Dockerfile + docker-compose.yml onto each server
#   2. Prepare the persistent host directories for SyncThing to replicate:
#        mkdir -p /data/onlinewiki /var/log/onlinewiki
#   3. docker compose up -d --build
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    env_file: .env
    volumes:
      - /data/onlinewiki:/var/lib/onlinewiki   # ★ HOST bind-mount → container DATA_DIR
      - /var/log/onlinewiki:/var/log/onlinewiki # container LOG_DIR
```

```powershell
# Bare-metal (legacy / in-place) — repeat on every server:
git clone <repo>  (or copy project folder)
npm install                    # install deps locally — node_modules is NOT synced
Copy-Item .env.example .env    # configure each server's .env independently
```

**2. Configure `.env` identically on every server**

Set these shared values on **every** node. All of them are read from `.env` at startup; they are **not** read from DATA_DIR:

```env
# ── Storage — the ONE folder SyncThing needs to replicate (★ Docker / prod defaults)
DATA_DIR=/var/lib/onlinewiki            # SAME value on EVERY server (container-side path)
LOG_DIR=/var/log/onlinewiki             # CAN be different per server, but keep it simple

# For bare-metal Windows deployments instead:
# DATA_DIR=X:\OnlineWiki-Data           # SAME value on every server
# LOG_DIR=D:\Logs\OnlineWikiA           # DIFFERENT per server

# ── Session sharing — identical on EVERY server
SESSION_SECRET=paste-the-SAME-64-char-hex-string-on-ALL-servers
SESSION_MODE=syncthing
MAINTENANCE_TOKEN=paste-a-long-random-bearer-token

SESSION_MAX_AGE_HOURS=8
PORT=3000                               # CAN differ per server
LDAP_URL=ldap://your-domain-controller  # same AD / DC pool
```

Generate secrets quickly:
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # MAINTENANCE_TOKEN
```

**3. Set up SyncThing share → ONE FOLDER (DATA_DIR) ★ DEFAULT / RECOMMENDED**

SyncThing replicates **only the DATA_DIR persistent volume folder** — never the application code (code ships inside the Docker image or is deployed via git/robocopy independently).

- On **every** server, open SyncThing and add a single "Folder" entry that points to the **host-side absolute path of DATA_DIR**:
  - Docker Linux: `/data/onlinewiki` (the bind-mount source, not the container `/var/lib/onlinewiki` target)
  - Bare-metal Windows: `X:\OnlineWiki-Data`
  - Bare-metal Linux: `/srv/onlinewiki-data`
- **Copy TEMPLATE B** (the DATA_DIR-only `.stignore`) from the project's [`.stignore`](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/.stignore#L44-L64) and paste it as **`<DATA_DIR>/.stignore`** inside the shared folder. TEMPLATE B ignores:
  - ❌ `sessions/*.tmp`, `sessions/*.tmp.*`, `sessions/*.lock` (transient atomic-write scratch)
  - ❌ stray `logs/` or `*.log` files that might accidentally end up inside DATA_DIR
  - ❌ `.stfolder/`, `.stversions/`, `.DS_Store`, `Thumbs.db` (SyncThing/OS metadata)
- Contents that SyncThing must carry **and are NOT ignored**:
  - ✅ `pages/`, `uploads/`, `avatars/`
  - ✅ `users.json`, `settings.json`
  - ✅ `sessions/*.json` (the final session files — not the tmp/lock scratch!)

> **Legacy / whole-repo share alternative (not recommended for Docker):** if you run bare-metal with DATA_DIR still at the relative `data/` inside the repo, you *can* share the entire project folder instead — use **TEMPLATE A** (further down in `.stignore`, already active in the repo-root copy) which additionally excludes `node_modules/`, `.env`, `logs/`, `test_files/`, and editor/OS cruft. For Docker deployments this approach is unnecessary because the code is baked into the image and never needs syncing.

**4. Enable STICKY SESSIONS on your load balancer**

This step is **required** for SyncThing-synced sessions to behave cleanly:
- Without sticky sessions: every HTTP request could hit a different server, and the rolling `cookie.maxAge` extension re-writes the session JSON before SyncThing has time to replicate it — you'll see `.sync-conflict-…` files pile up inside `<DATA_DIR>/sessions/` and users get randomly logged out.
- **With sticky sessions:** each user sticks to *one* server for ~8 hours (one `SESSION_MAX_AGE` window). SyncThing only needs to replicate the session file once at login, and again if the user's role/displayName changes. Failover to another server is still automatic if the pinned node dies — the replicated session JSON on Server B picks it up within SyncThing's normal ~few-second lag.

How to configure it:
- **Kemp / F5 / IIS ARR / NetScaler:** use "source IP affinity" or "cookie-based persistence"
- **HAProxy:** `stick-table type ip size 1m expire 8h store http_req_rate(10s)` + `stick on src`
- **nginx:** `ip_hash;` directive in the `upstream { }` block, or the `sticky` module

**5. Schedule the global session reaper (EXACTLY ONE scheduled task total across the cluster)**

In `SESSION_MODE=syncthing` every server's built-in reaper is **disabled**. If each server deleted its own expired sessions, those deletes would race with SyncThing replication. Instead, run a single HTTP call, from **one** machine, hourly.

On a nominated controller server (e.g. the same SyncThing "introducer", or any one app server) create a **Scheduled Task** that runs every 60 minutes and calls:

```powershell
# Run-ExpireSessions.ps1 (or inline in Scheduled Task)
$token = "paste-MAINTENANCE_TOKEN-here"
$uri   = "https://wiki.corp.yourdomain.com/api/maintenance/expire-sessions"
Invoke-RestMethod -Uri $uri -Method Post -Headers @{ Authorization = "Bearer $token" } | Out-Null
```

If you want to run the reaper *via the web UI* instead (as an administrator), that also works — log in as an admin, send a POST with the page's `_csrf` token, and the same endpoint responds. The endpoint returns JSON:
```json
{ "ok": true, "reason": "Reap cycle invoked via session-file-store.reap().", "mode": "syncthing", "reapable": true }
```

**6. Start the server on every node**

```bash
# ★ Docker (recommended)
docker compose up -d --build
docker compose logs -f onlinewiki    # tail logs to confirm startup
```

```powershell
# Bare-metal
npm start
```

Each server's boot log prints its session mode — you want to see exactly:
```
info: [session] mode=syncthing — <DATA_DIR>/sessions/ MUST be synced by SyncThing,
      built-in reaper is DISABLED (reap once globally via POST /api/maintenance/expire-sessions
      from ONE nominated server). Also ensure your load balancer enables STICKY SESSIONS
      (source-IP affinity or cookie) to minimise session-file race writes during SyncThing lag.
```
Plus the banner always prints the canonical DATA_DIR + LOG_DIR so you can confirm both nodes point to the same share:
```
# Docker:
Persistent data (DATA_DIR=/var/lib/onlinewiki): /var/lib/onlinewiki
Local logs        (LOG_DIR =/var/log/onlinewiki):  /var/log/onlinewiki

# Bare-metal Windows:
Persistent data (DATA_DIR=X:\OnlineWiki-Data):  X:\OnlineWiki-Data
Local logs        (LOG_DIR =D:\Logs\WikiA):      D:\Logs\WikiA
```

---

### Conflict handling

| Scenario | What happens |
|---|---|
| Two users edit **different** pages simultaneously on different servers | ✅ No conflict — separate files |
| Two users edit the **same** page simultaneously on different servers | ⚠ Last save wins. The app shows a warning banner to the second saver. SyncThing creates a `.sync-conflict-…` copy of the earlier version |
| SyncThing conflict copies (`.sync-conflict-…json`) appear in `<DATA_DIR>/pages/` | ✅ Automatically ignored — the app filters them out and they never appear as pages |
| A user uploads a file on Server A | ✅ SyncThing syncs it to all other servers within seconds |
| User's session is pinned to Server A, Server A dies | ✅ LB falls them to Server B; Server B already has the session JSON (synced); they stay logged in without re-auth |
| User updates their profile / role changes | ✅ Session JSON is re-written on the pinned server; SyncThing replicates it within seconds |

### SyncThing conflict copies

When SyncThing detects a write conflict it creates a file like:
```
<DATA_DIR>/pages/my-page.sync-conflict-20260902-143012-DEVICEID.json
<DATA_DIR>/sessions/2DQw41MHBQ66BQ6ZSKi.sync-conflict-20260909-180000-DEVICEID.json
```
Page conflict copies are **silently ignored** by the application (filtered in `listPages()`).  
Session conflict copies: if you ever see them inside `<DATA_DIR>/sessions/` it means sticky sessions are not configured at the LB. The file with the newer `mtime` is the authoritative one; you can safely delete the `*.sync-conflict-*` version after confirming the user can still log in.

### Recommended write strategy

For best results, designate **one primary server** as the main editing server and treat other servers as read replicas. SyncThing will propagate all changes within seconds. Simultaneous edits from multiple servers are safe but will trigger the conflict warning.

### Monitoring sync status

You can check SyncThing sync status at `http://localhost:8384` (default SyncThing web UI) on any server to confirm all nodes are up to date before making important edits.

Verify session sharing end-to-end with:
```powershell
# On Server A: log in via browser, then:
#   Stop-Service -Name OnlineWikiA    (or kill the node process)
# On the browser: reload — should still be authenticated via Server B.
```
