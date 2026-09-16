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

<!-- ═══════════════════════════════════════════════════════════════════════
     ARCHITECTURE OVERVIEW
     Section 1 of README: High-level architecture before any deployment
     step-by-step.  Introduce design, then drill into Deployment HOWTOs.
     ═══════════════════════════════════════════════════════════════════════ -->

## Architecture Overview

OnlineWiki is a **single-root, flat-file, horizontally-scalable wiki** designed for
corporate intranets.  Its defining architectural principle is:

> **Every piece of persistent state lives inside exactly one configurable folder
> (`DATA_DIR`).  Point a directory replicator (SyncThing, DFS-R, rsync, …) at that
> one folder, and every server in the cluster converges to identical state.**

Nothing else needs synchronising between nodes — the application code ships
inside Docker images, and per-instance logs are deliberately kept separate.

### Design Principles

| # | Principle | Why it matters |
|---|---|---|
| 1 | **Single storage root** (`DATA_DIR`) | One replication target → no missing pieces, dead-simple DR |
| 2 | **Flat files, no database** | Pages/users/settings are JSON files — readable offline, no DB admin, portable backups |
| 3 | **Application code ≠ state** | Code lives in the Docker image; SyncThing only replicates `DATA_DIR` (re-imaging never destroys data) |
| 4 | **Optional session sharing** (`SESSION_MODE`) | Three strategies: single-server, SyncThing-file-sync, or Redis — pick the one that matches your infra |
| 5 | **Layered idle-time enforcement** | Idle sessions don't linger on shared kiosks; rolling cookie + client-side monitor + pre-expiry warning |
| 6 | **Conflict awareness, not avoidance** | Concurrent page edits are detected, user is warned, and SyncThing keeps the losing save as a `*.sync-conflict-*` copy (app filters it out of listings) |

### Top-Level Component Map

```
                     ┌──────────────────────────────┐
                     │      DNS / Load Balancer     │
                     │   ⚠ requires STICKY SESSIONS │  ← cookie or source-IP affinity
                     └──────────────┬───────────────┘
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
      ┌─ OnlineWiki Node A ────────────┐    ┌─ OnlineWiki Node B ────────────┐
      │  ┌─────────────────────────┐   │    │  ┌─────────────────────────┐   │
      │  │  Node.js runtime        │   │    │  │  Node.js runtime        │   │
      │  │  server.js (Express)    │   │    │  │  server.js (Express)    │   │
      │  │   · routes & auth       │   │    │  │   · routes & auth       │   │
      │  │   · flat-file I/O       │   │    │  │   · flat-file I/O       │   │
      │  │   · EJS templating      │   │    │  │   · EJS templating      │   │
      │  │   · TinyMCE + client JS │   │    │  │   · TinyMCE + client JS │   │
      │  └────┬────────────────┬───┘   │    │  └────┬────────────────┬───┘   │
      │       ▼ bind-mount     ▼       │    │       ▼ bind-mount     ▼       │
      │  ┌────────────┐  ┌──────────┐ │    │  ┌────────────┐  ┌──────────┐ │
      │  │  DATA_DIR  │  │ LOG_DIR  │ │    │  │  DATA_DIR  │  │ LOG_DIR  │ │
      │  │ (same data │  │ (per-node│ │    │  │ (same data │  │ (per-node│ │
      │  │  on every  │  │  logs,   │ │    │  │  on every  │  │  logs,   │ │
      │  │   server)  │  │  private)│ │    │  │   server)  │  │  private)│ │
      │  └─────┬──────┘  └──────────┘ │    │  └─────┬──────┘  └──────────┘ │
      └────────┼───────────────────────┘    └────────┼───────────────────────┘
               ▼                                      ▼
        ┌──── SyncThing directory replicator ─────┐   ← ONE FOLDER: DATA_DIR
        │  syncs:  pages/, uploads/, avatars/,    │          TEMPLATE B
        │         sessions/*.json, users.json,    │          .stignore at
        │         settings.json                   │          DATA_DIR/.stignore
        │  ignores: sessions/*.tmp, *.lock, logs/ │
        └─────────────────────────────────────────┘
```

> **Bare-metal variant (no containers):** Replace the Node.js container box with a
> plain `node server.js` systemd / SCM service running directly on the host, and
> `DATA_DIR` becomes a local path (`data/`, `X:\OnlineWiki-Data`, …).  Everything
> else in the diagram stays identical.

### Single-Root Directory Layout (`DATA_DIR` + `LOG_DIR`)

```
OnlineWiki/                              ← application code (ships in the Docker image;
                                          never synced between nodes)
├── server.js            Express routes, LDAP auth, session layer
├── .env                 Per-node configuration (never commit, never sync)
├── .env.example         Template with production-safe defaults
├── views/               EJS templates (layout, login, home, page, edit, uploads, error)
├── public/
│   ├── css/style.css    UI theme (dark, glassmorphism)
│   └── js/
│       ├── app.js       Sidebar, live search, session idle monitor, attachment picker
│       └── editor.js    TinyMCE init, slug auto-generation, save-btn guard logic
├── lib/logger.js        Winston (daily rotate, reads LOG_DIR from env)
├── test_files/          Local scratch data (NEVER commit / NEVER sync)
│
├── <DATA_DIR>/          ★  Consolidated persistent root — the ONE folder SyncThing
│   │                      replicates.  Exactly one of:
│   │                         Docker (default):  /var/lib/onlinewiki
│   │                         Bare-metal (rel):  data/
│   │                         Bare-metal (abs):  X:\OnlineWiki-Data  /srv/onlinewiki-data
│   ├── pages/           Each page is one JSON file:  <slug>.json
│   ├── uploads/         Binary document uploads + image uploads
│   ├── avatars/         Per-user profile pictures (circular PNG/JPG)
│   ├── sessions/        Session files (only *.json are synced; *.tmp / *.lock ignored)
│   ├── users.json       Local user registry + role map + bcrypt hashes
│   └── settings.json    Site title, tagline, home heading, registration policy
│
└── <LOG_DIR>/           Per-instance logs — NEVER replicate between servers
                          Docker:  /var/log/onlinewiki
                          Bare:    logs/  (inside repo, or D:\Logs\WikiA etc.)
                          Contents:  combined-<date>.log  +  audit-<date>.log
```

Environment mapping:

| Variable | Docker default | Sync? | Notes |
|---|---|---|---|
| `DATA_DIR` | `/var/lib/onlinewiki` | ✅ YES, via TEMPLATE B | Same *container-side* value on every server; host bind-mount source can differ |
| `LOG_DIR` | `/var/log/onlinewiki` | ❌ NO | Per-instance diagnostics; deliberately not replicated |

### Multi-Server Architecture Diagram (Detailed)

```
                         ┌─────────────────────────────┐
                         │     DNS / Load Balancer     │
                         │   ⚠ STICKY SESSIONS REQUIRED│   cookie or source-IP affinity
                         └──────────────┬──────────────┘
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
    ┌── Server A (Office 1) ────────────────────┐  ┌── Server B (Office 2) ────────────────────┐
    │                                            │  │                                            │
    │  ┌─ Docker container ──────────────────┐  │  │  ┌─ Docker container ──────────────────┐  │
    │  │  · node server.js                   │  │  │  │  · node server.js                   │  │
    │  │  · Express + Passport (LDAP/local)  │  │  │  │  · Express + Passport (LDAP/local)  │  │
    │  │  · DATA_DIR = /var/lib/onlinewiki   │  │  │  │  · DATA_DIR = /var/lib/onlinewiki   │  │   SAME on both
    │  │  · LOG_DIR  = /var/log/onlinewiki   │  │  │  │  · LOG_DIR  = /var/log/onlinewiki   │  │
    │  └──────┬──────────────────┬───────────┘  │  │  └──────┬──────────────────┬───────────┘  │
    │         ▼ bind-mount       ▼ bind-mount    │  │         ▼ bind-mount       ▼ bind-mount    │
    │  ┌────────────────┐  ┌──────────────────┐  │  │  ┌────────────────┐  ┌──────────────────┐  │
    │  │ HOST DATA_DIR  │  │ HOST LOG_DIR     │  │  │  │ HOST DATA_DIR  │  │ HOST LOG_DIR     │  │   LOG_DIRs DIFFER
    │  │ /data/onlinewiki│  │ /var/log/ow     │  │  │  │ /data/onlinewiki│  │ /var/log/ow     │  │
    │  └──────┬─────────┘  └──────────────────┘  │  │  └──────┬─────────┘  └──────────────────┘  │
    │         │                                  │  │         │                                  │
    │         │ pages/      ──── SYNCED ────→    │  │         │ pages/                          │
    │         │ uploads/    ──── SYNCED ────→    │  │         │ uploads/                        │
    │         │ avatars/    ──── SYNCED ────→    │  │         │ avatars/                        │
    │         │ users.json  ──── SYNCED ────→    │  │         │ users.json                      │
    │         │ settings.json─── SYNCED ────→    │  │         │ settings.json                   │
    │         │ sessions/*.json ── SYNCED ──→    │  │         │ sessions/*.json                 │   SESSIONS SHARED
    │         │                                  │  │         │                                  │
    │  reaper: DISABLED                          │  │  reaper: HOURLY                         │   EXACTLY ONE reaper
    │  (all built-in reapers disabled when       │  │  via POST /api/maintenance/expire-       │   task across the
    │   SESSION_MODE=syncthing)                  │  │      sessions with MAINTENANCE_TOKEN     │   whole cluster
    └──────────────┬─────────────────────────────┘  └──────────────┬─────────────────────────────┘
                   ▼                                               ▼
                ┌─ SyncThing directory replicator (SINGLE FOLDER: the HOST DATA_DIR, e.g. /data/onlinewiki) ─┐
                │  · Syncs:  pages/, uploads/, avatars/, sessions/*.json, users.json, settings.json           │
                │  · Ignores (TEMPLATE B in .stignore, copied INTO DATA_DIR root):                              │
                │       sessions/*.tmp, sessions/*.tmp.*, sessions/*.lock, logs/, *.log,                       │
                │       .stfolder/, .stversions/, .DS_Store, Thumbs.db                                         │
                │  · Application code lives inside the Docker image — never synced by SyncThing                 │
                └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Session Sharing: Three Modes

Choose exactly one in `.env` and set it identically on every node:

| Mode | `SESSION_MODE` | Sharing mechanism | Reaper strategy |
|---|---|---|---|
| Single server (default) | `single` | In-memory + DATA_DIR disk — isolated per node | Built-in, hourly per node |
| **SyncThing (recommended for LB + ST)** | `syncthing` | `<DATA_DIR>/sessions/*.json` replicated by SyncThing | **Exactly one server** runs `POST /api/maintenance/expire-sessions` hourly (Scheduled Task / cron) |
| Redis | `redis` | Central Redis store | Native TTL on keys; no reaper needed |

All three modes require an **identical** `SESSION_SECRET` across the cluster, otherwise signed cookies cannot be validated on other nodes.

### Conflict Handling Matrix

| Scenario | Outcome |
|---|---|
| Two users edit **different** pages on two servers | ✅ No conflict — two independent JSON files |
| Two users edit the **same** page on two servers | ⚠ Last write wins; second saver shown conflict banner; SyncThing writes the loser to `<slug>.sync-conflict-<ts>-<devId>.json` |
| `*.sync-conflict-*` files appear in `<DATA_DIR>/pages/` | ✅ App silently filters them out of `listPages()`; visible only for manual recovery |
| `*.sync-conflict-*` files appear in `<DATA_DIR>/sessions/` | ⚠ Diagnostic: sticky sessions misconfigured at LB.  Keep the most-recently-written copy, delete the conflict. |
| File uploaded on Server A | ✅ SyncThing carries it to all other nodes in ~seconds |
| Pinned Server A dies mid-session | ✅ LB rebalances user to Server B; replicated session JSON keeps them authenticated without re-login |
| User role / displayName change on pinned server | ✅ Session JSON re-written; SyncThing propagates to peers; no re-login |

### Session Idle-Time Enforcement (Layered Model)

Abandoned sessions on shared kiosk-style machines are cleaned up via three cooperative layers:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 · Server-side hard ceiling (rolling cookie)                       │
│  SESSION_MAX_AGE_HOURS=8 (default)                                         │
│  Absolute upper bound — session expires 8 h from the FIRST login,          │
│  even with continuous use.  Every authenticated HTTP request re-issues     │
│  the cookie with a fresh Max-Age (rolling:true), extending this ceiling    │
│  up to the limit from the LAST activity.                                   │
├────────────────────────────────────────────────────────────────────────────┤
│  LAYER 2 · Client-side human-activity monitor                              │
│  SESSION_IDLE_MINUTES=15 (default)                                         │
│  Listens only for HUMAN input: keypress, mousedown / move / click,         │
│  scroll, touch, pointer, wheel, drag.  Asset fetches, keepalive polls,    │
│  and background XHRs do NOT reset the idle timer.                          │
├────────────────────────────────────────────────────────────────────────────┤
│  LAYER 3 · Pre-expiry warning with live countdown                          │
│  SESSION_IDLE_WARN_SECONDS=120 (default)                                   │
│  N seconds before Layer 2 fires, accessible `<div role=alertdialog>` pops  │
│  up with a countdown chip + two buttons:                                   │
│    [Extend session]  →  GET /api/session/keepalive → 204 No Content        │
│                           resets both client idle timer AND the rolling     │
│                           server-side cookie; closes the modal             │
│    [Log out now]     →  POST /logout  (CSRF-safe form)                     │
│  Countdown chip turns red when ≤ 30 s remain; ESC ≡ [Log out now].         │
└────────────────────────────────────────────────────────────────────────────┘
```

**User-visible flow:**

```
 User active  ──►  (nothing)
     │
     ▼  idle for (SESSION_IDLE_MINUTES × 60) − SESSION_IDLE_WARN_SECONDS  sec
 Warning dialog with countdown appears
     │
     ├─ [Extend session] clicked  ─► keepalive 204  ─► cookie + idle reset
     │
     ├─ Any HUMAN input (key / mouse / scroll / …)  ─► idle reset + dismiss
     │
     ├─ [Log out now] clicked  ─► POST /logout  ─►  /login  (manual)
     │
     ▼  Countdown reaches 0
  Auto  POST /logout?reason=inactive
     │
     ▼  /login?reason=inactive — friendly banner:
        "You were signed out automatically because you were inactive.
         Sign back in to continue."
```

To disable idle enforcement entirely (air-gapped intranets with no shared kiosks),
set **either** variable to zero or break the inequality:

```env
SESSION_IDLE_MINUTES=0
# or
SESSION_IDLE_WARN_SECONDS=0
# or
SESSION_IDLE_WARN_SECONDS >= SESSION_IDLE_MINUTES * 60
```

Every logout (manual or idle) writes a `USER_LOGOUT` event to the per-day audit log
`<LOG_DIR>/audit-YYYY-MM-DD.log` with a `reason` of `"manual"` or `"inactive"`.

### Page Storage Wire Format

Each page is exactly one file: `<DATA_DIR>/pages/<slug>.json`

```json
{
  "title": "Getting Started",
  "slug": "getting-started",
  "content": "<p>HTML from the TinyMCE editor…</p>",
  "tags": ["setup", "onboarding"],
  "author": "jdoe",
  "authorDisplay": "Jane Doe",
  "createdAt": "2026-09-02T02:00:00.000Z",
  "updatedAt": "2026-09-02T04:00:00.000Z",
  "attachments": ["1725235200000_User_Guide.pdf"]
}
```

---

<!-- ═══════════════════════════════════════════════════════════════════════
     DEPLOYMENT  ·  Docker (Recommended for Production)
     ═══════════════════════════════════════════════════════════════════════ -->

## ★ Docker Deployment (Recommended for Production)

### 1. Prepare the environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in the required values. The defaults in `.env.example` are already tuned for Docker:

```env
# ── Docker-mounted persistent storage
DATA_DIR=/var/lib/onlinewiki   # Container-side path — mount a host dir / named volume here
LOG_DIR=/var/log/onlinewiki    # Optional second volume for logs

# ── Session sharing across containers (identical on every node)
SESSION_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
SESSION_MODE=syncthing         # Sessions replicated by SyncThing through the shared DATA_DIR
MAINTENANCE_TOKEN=<generate:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">

# ── LDAP / Active Directory
LDAP_URL=ldap://your-domain-controller.example.com
LDAP_BIND_DN=cn=svc-wiki,ou=ServiceAccounts,dc=example,dc=com
LDAP_BIND_PASSWORD=your-service-account-password
LDAP_BASE_DN=dc=example,dc=com
```

> **Tip:** Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` in `.env` if your DC uses a self-signed certificate.

### 2. Example Dockerfile

```dockerfile
# Dockerfile for OnlineWiki
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first — better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

EXPOSE 3000

# ⚠ Do NOT declare a VOLUME here — declare them in docker-compose.yml or with
# `docker run -v` so you control the host-side path (SyncThing needs this to
# replicate the same DATA_DIR across nodes consistently).

CMD ["npm", "start"]
```

### 3. docker-compose.yml — Single node

```yaml
# docker-compose.yml  ·  deploy to every server running OnlineWiki + SyncThing
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      # ★ PERSISTENT STORAGE — map container DATA_DIR to an EXTERNAL location.
      # Use a NAMED VOLUME for a single server; use a HOST BIND-MOUNT for
      # multi-server SyncThing (so the host SyncThing daemon can read it).
      - onlinewiki_data:/var/lib/onlinewiki
      # Optional: logs on the host for collectors
      - onlinewiki_logs:/var/log/onlinewiki

volumes:
  onlinewiki_data:   # replace with bind mount if needed: /data/onlinewiki:/var/lib/onlinewiki
  onlinewiki_logs:
```

### 4. docker-compose.yml — Multi-server SyncThing variant

```yaml
# docker-compose.yml · multi-server — SAME file on every node
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      # ★ HOST BIND-MOUNT — SyncThing on the host replicates this directory.
      # Container-side /var/lib/onlinewiki is identical on every server, so
      # env configs stay identical.
      - /data/onlinewiki:/var/lib/onlinewiki
      - /var/log/onlinewiki:/var/log/onlinewiki
```

**Start the stack on every node:**
```bash
docker compose up -d --build
```

**Set up SyncThing (host or sidecar container):**
- On every node, point SyncThing at the **host-side** directory (e.g. `/data/onlinewiki`).
- Copy **TEMPLATE B** (the `DATA_DIR`-only `.stignore`) from [`.stignore`](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/.stignore#L30-L65) and drop it into `<host-DATA_DIR>/.stignore` (e.g. `/data/onlinewiki/.stignore`).  This is the **default / recommended** template.  It ignores transient `sessions/*.tmp`, `sessions/*.lock`, and stray `logs/`; everything else (pages, uploads, avatars, `sessions/*.json`, `users.json`, `settings.json`) is replicated.
- Enable **sticky sessions** on your load balancer (cookie or source-IP affinity).
- Schedule **exactly one** global session reaper across the cluster: a single hourly hit on any node's `POST /api/maintenance/expire-sessions` with the `MAINTENANCE_TOKEN`.

---

<!-- ═══════════════════════════════════════════════════════════════════════
     DEPLOYMENT  ·  Bare-metal / Local Dev (npm start)
     ═══════════════════════════════════════════════════════════════════════ -->

## Alternative: Bare-metal / Local Dev Setup (npm start)

Use this for single-server installs or local dev on Windows/Linux/macOS with Node installed.

### 1. Copy the environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in your AD details.  For bare-metal you can keep `DATA_DIR=data` (inside the repo) or point it at a mapped drive / UNC:

```env
DATA_DIR=data
LOG_DIR=logs

SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

LDAP_URL=ldap://your-domain-controller.example.com
LDAP_BIND_DN=cn=svc-wiki,ou=ServiceAccounts,dc=example,dc=com
LDAP_BIND_PASSWORD=your-service-account-password
LDAP_BASE_DN=dc=example,dc=com
```

> **Tip:** `LDAP_TLS_REJECT_UNAUTHORIZED=false` for DCs with self-signed certificates.

### 2. Install dependencies

```powershell
npm install
```

### 3. Start the server

```powershell
npm start          # production
npm run dev        # development (auto-reload via nodemon)
```

Wiki is available at **http://localhost:3000** (or the `PORT` from `.env`).

---

<!-- ═══════════════════════════════════════════════════════════════════════
     DEPLOYMENT  ·  SyncThing session-sharing step-by-step
     (SESSION_MODE=syncthing)
     ═══════════════════════════════════════════════════════════════════════ -->

## SyncThing Session Sharing (Step-by-Step)

Assumes `SESSION_MODE=syncthing`.  Use Docker (recommended) or bare-metal — the
SyncThing setup steps are identical; only the host-side DATA_DIR path changes.

### 1. Deploy the app to every server

**DOCKER (recommended):**
```yaml
# docker-compose.yml — every server
services:
  onlinewiki:
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    env_file: .env
    volumes:
      - /data/onlinewiki:/var/lib/onlinewiki   # HOST bind-mount → container DATA_DIR
      - /var/log/onlinewiki:/var/log/onlinewiki # container LOG_DIR
```
```bash
docker compose up -d --build
```

**BARE-METAL (legacy in-place):**
```powershell
git clone <repo>  (or copy project folder)
npm install                    # node_modules is NOT synced
Copy-Item .env.example .env    # .env configured independently per server
npm start
```

### 2. Configure `.env` — identical shared values on every node

All values below are read from `.env` at startup (NOT from `DATA_DIR`):

```env
# Storage — the ONE folder SyncThing replicates (★ Docker / production defaults)
DATA_DIR=/var/lib/onlinewiki            # SAME value on EVERY server (container path)
LOG_DIR=/var/log/onlinewiki             # CAN differ per server

# Bare-metal Windows example instead:
# DATA_DIR=X:\OnlineWiki-Data           # SAME on every server
# LOG_DIR=D:\Logs\OnlineWikiA           # DIFFERENT per server

# Session sharing — identical on EVERY server
SESSION_SECRET=<paste the SAME 48+ char hex string on ALL nodes>
SESSION_MODE=syncthing
MAINTENANCE_TOKEN=<paste a long random bearer token>

SESSION_MAX_AGE_HOURS=8
PORT=3000                               # CAN differ per server
LDAP_URL=ldap://your-domain-controller  # same AD / DC pool
```

Secrets quick-generator:
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # MAINTENANCE_TOKEN
```

### 3. Add one SyncThing folder → `DATA_DIR` (only!)

SyncThing replicates **only the `DATA_DIR` persistent volume folder** — never the
application code (code ships inside the Docker image, or is deployed independently
via git/robocopy).

1. On **every** node, open SyncThing and add a single **Folder** that points to the **host-side** absolute path of `DATA_DIR`:
   - Docker Linux: `/data/onlinewiki` (the bind-mount **source**, not the container `/var/lib/onlinewiki` target)
   - Bare-metal Windows: `X:\OnlineWiki-Data`
   - Bare-metal Linux: `/srv/onlinewiki-data`
2. **Copy TEMPLATE B** (the `DATA_DIR`-only `.stignore`) from [`.stignore`](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/.stignore#L44-L64) and paste it as **`<DATA_DIR>/.stignore`** inside the shared folder.

**TEMPLATE B ignores:**
- ❌ `sessions/*.tmp`, `sessions/*.tmp.*`, `sessions/*.lock` (atomic-write scratch files)
- ❌ Stray `logs/` or `*.log` accidentally dropped into `DATA_DIR`
- ❌ `.stfolder/`, `.stversions/`, `.DS_Store`, `Thumbs.db` (SyncThing / OS metadata)

**TEMPLATE B syncs (must carry these):**
- ✅ `pages/`, `uploads/`, `avatars/`
- ✅ `users.json`, `settings.json`
- ✅ `sessions/*.json` (the final session files — NOT the tmp / lock scratch!)

> **Legacy whole-repo share (not recommended for Docker):** If you run bare-metal
> with `DATA_DIR` still at the relative `data/` inside the repo, you *can* share
> the entire project folder instead — use **TEMPLATE A** (further down in
> `.stignore`, active in the repo-root copy) which additionally excludes
> `node_modules/`, `.env`, `logs/`, `test_files/`, and editor/OS cruft.  In
> Docker deployments this is unnecessary because the code is baked into the image.

### 4. Enable sticky sessions on the LB (REQUIRED for SESSION_MODE=syncthing)

Without sticky sessions every HTTP request can land on a different server, and the
rolling cookie re-writes the session JSON faster than SyncThing can replicate —
`.sync-conflict-*` sessions pile up and users get randomly logged out.

With sticky sessions: each user sticks to *one* server for roughly one
`SESSION_MAX_AGE` window.  SyncThing only needs to replicate the session JSON
once at login (+ once on role / displayName change).  Failover is still automatic
if the pinned node dies — the replicated session JSON on the peer node picks the
user up within SyncThing's normal few-second lag.

Example LB configs:
- **Kemp / F5 / IIS ARR / NetScaler:** source-IP affinity or cookie-based persistence
- **HAProxy:** `stick-table type ip size 1m expire 8h store http_req_rate(10s)` + `stick on src`
- **nginx:** `ip_hash;` (upstream) or the `sticky` module

### 5. Schedule ONE global session reaper (cluster-wide)

With `SESSION_MODE=syncthing` every node's built-in hourly reaper is **disabled**
(prevents delete-vs-delete races with SyncThing replication).  Instead, run a
single HTTP POST, from **one** nominated machine, once per hour:

```powershell
# Schedule this in Task Scheduler / cron — EXACTLY ONE task total cluster-wide
$token = "paste-MAINTENANCE_TOKEN-here"
$uri   = "https://wiki.corp.yourdomain.com/api/maintenance/expire-sessions"
Invoke-RestMethod -Uri $uri -Method Post `
    -Headers @{ Authorization = "Bearer $token" } | Out-Null
```

Admins may also POST through the web UI (using the page's `_csrf` token).  Endpoint
returns:
```json
{ "ok": true, "reason": "Reap cycle invoked via session-file-store.reap().",
  "mode": "syncthing", "reapable": true }
```

### 6. Boot banner verification

Each node's boot log prints the storage paths + session mode so you can confirm at
a glance that everything is wired consistently:

```
Persistent data (DATA_DIR=/var/lib/onlinewiki): /var/lib/onlinewiki
Local logs        (LOG_DIR =/var/log/onlinewiki):  /var/log/onlinewiki

info: [session] mode=syncthing — <DATA_DIR>/sessions/ MUST be synced by SyncThing,
      built-in reaper is DISABLED (reap once globally via POST /api/maintenance/expire-sessions
      from ONE nominated server). Also ensure your load balancer enables STICKY SESSIONS
      (source-IP affinity or cookie) to minimise session-file race writes during SyncThing lag.
```

---

<!-- ═══════════════════════════════════════════════════════════════════════
     OPERATIONS / DAY-TO-DAY
     Uploading, LDAP troubleshooting, sync monitoring.
     ═══════════════════════════════════════════════════════════════════════ -->

## Uploading Documents

1. Open **Documents** in the sidebar
2. Drag & drop, or click **Choose File** — supported types: PDF, Word, Excel, PowerPoint, images, ZIP, CSV (max 50 MB per file)
3. To attach to a page: open the page editor → **Quick Media Insert** sidebar panel → use **Insert Image…** or **Insert Link to File…**
4. On the page view, attachments are download buttons — files download before opening (no inline Office preview).

## LDAP Troubleshooting

| Symptom | Fix |
|---|---|
| "Authentication error" on login | Verify `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` |
| Certificate errors | Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` |
| Wrong users found | Adjust `LDAP_SEARCH_FILTER` (default: `(sAMAccountName={{username}})`) |
| `ldap://` vs `ldaps://` | `ldaps://` = port 636, TLS-secured LDAP |

Check the server console for `[LDAP]` prefixed error lines when diagnosing auth.

## Monitoring Sync Status

SyncThing UI lives at `http://localhost:8384` (default) on each server.  Confirm all
nodes report "Up to Date" before making large or important edits.

Session sharing smoke test:
```powershell
# On Server A — log in via browser, then:
#   Stop-Service -Name OnlineWikiA    (or kill the node process)
# In the same browser — reload the page.
# Expected: still authenticated, served by Server B via LB, no re-login prompt.
```

---

<!-- ═══════════════════════════════════════════════════════════════════════
     REFERENCE · Environment Variables
     ═══════════════════════════════════════════════════════════════════════ -->

## Environment Variable Reference (Complete)

All variables are read from `.env` at startup. For multi-server deployments, variables marked **(SHARED)** must be identical on every node; variables marked **(PER-NODE)** can differ.

| Variable | Default | Scope | Type | Description |
|---|---|---|---|---|
| **Runtime** | | | | |
| `NODE_ENV` | `development` | SHARED | string | `development` or `production` (affects error-page verbosity, Helmet settings) |
| `LOG_LEVEL` | `info` | PER-NODE | string | Winston log level: `error` / `warn` / `info` / `http` / `debug` |
| `PORT` | `3000` | PER-NODE | int | HTTP listen port. In Docker the container-internal port stays 3000; map externally via `-p 80:3000`. |
| **Storage** | | | | |
| `DATA_DIR` | Docker: `/var/lib/onlinewiki`<br>Bare-metal: `data` | SHARED* | path | ONE single persistent-storage root folder. SyncThing replicates ONLY this directory. *Container-side value identical on every node; host-side bind-mount source can vary by node. |
| `LOG_DIR` | Docker: `/var/log/onlinewiki`<br>Bare-metal: `logs` | PER-NODE | path | Per-instance system + audit logs. **NEVER sync this directory** between servers. |
| **Session core** | | | | |
| `SESSION_SECRET` | (placeholder — MUST set) | SHARED | string | 48+ char hex string for signing cookies. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `SESSION_MAX_AGE_HOURS` | `8` | SHARED | int | Hard absolute cookie ceiling. Session dies this many hours after first login, even with continuous activity (rolling cookie extends it up to this ceiling from last HTTP request). |
| `SESSION_MODE` | `single` | SHARED | enum | `single` — one server, built-in reaper.<br>`syncthing` — multi-server, sessions as DATA_DIR JSON, built-in reaper OFF, one global reaper cron required.<br>`redis` — Redis store, native TTL. |
| `MAINTENANCE_TOKEN` | (optional, commented) | SHARED | string | Bearer token for ONE-nominated-server call to `POST /api/maintenance/expire-sessions` when `SESSION_MODE=syncthing`. |
| **Idle enforcement (Option C)** | | | | |
| `SESSION_IDLE_MINUTES` | `15` | SHARED | int | Human inactivity threshold (minutes). `0` = disable idle monitor. |
| `SESSION_IDLE_WARN_SECONDS` | `120` | SHARED | int | Pre-expiry warning countdown (seconds). `0` = disable idle monitor. Must be `< SESSION_IDLE_MINUTES*60` or idle gate disables. |
| **Redis (optional)** | | | | |
| `REDIS_URL` | (not set) | SHARED | string | Priority Redis connection string: `redis[s]://[[username][:password]@][host][:port][/db-number]` |
| `REDIS_HOST` | (not set) | SHARED | string | Fallback Redis hostname (used when `REDIS_URL` is blank) |
| `REDIS_PORT` | `6379` | SHARED | int | Fallback Redis port |
| `REDIS_USERNAME` | (not set) | SHARED | string | Fallback Redis ACL username |
| `REDIS_PASSWORD` | (not set) | SHARED | string | Fallback Redis password |
| `REDIS_DB` | `0` | SHARED | int | Fallback Redis logical DB number |
| `REDIS_TLS` | `false` | SHARED | bool | Use `rediss://` (TLS) for the fallback connection |
| `REDIS_PREFIX` | `wiki:sess:` | SHARED | string | Key prefix so multiple apps share one Redis instance without collisions |
| **Local admin (dev / initial setup)** | | | | |
| `LOCAL_ADMIN_USERNAME` | (commented) | SHARED | string | Bypass-LDAP local account username. Blank / unset in production = no local account. |
| `LOCAL_ADMIN_PASSWORD` | (commented) | SHARED | string | Plaintext local admin password (bcrypt-hashed at boot). **Remove / leave blank in production.** |
| `LOCAL_ADMIN_DISPLAY_NAME` | `Local Administrator` | SHARED | string | Friendly name shown in UI for the local admin. |
| **LDAP / Active Directory** | | | | |
| `LDAP_URL` | `ldap://dc.example.com` | SHARED | string | Use `ldap://` (port 389) or `ldaps://` (port 636, TLS-secured LDAP). |
| `LDAP_BIND_DN` | `cn=svc-wiki,…` | SHARED | string | Read-only service account DN for searching the directory. |
| `LDAP_BIND_PASSWORD` | (must set) | SHARED | string | Password for the bind service account. |
| `LDAP_BASE_DN` | `dc=example,dc=com` | SHARED | string | Base DN under which user accounts are searched. |
| `LDAP_SEARCH_FILTER` | `(sAMAccountName={{username}})` | SHARED | string | Directory filter — `{{username}}` is replaced with the submitted username at auth time. |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | `true` | PER-NODE | bool | Set to `false` only for dev / self-signed DC certificates. |

---

## License

OnlineWiki is released under the **MIT License — With Attribution Requirement**
(SPDX short-form: `MIT WITH Attribution-3.0-OnlineWiki`).  It is still fully
open source — the only additional obligation beyond standard MIT is that
deployments / redistributions must preserve the attribution notices.

### Summary of obligations

| # | Obligation | Applies to |
|---|---|---|
| 1 | Copyright notice + this permission text preserved in all copies | Source, binaries, Docker images, redistributions — standard MIT base |
| 2 | **Attribution notice displayed in the running application UI** (footer / About / Credits) | Any deployment or derivative whose UI is reachable by end users (web / desktop / mobile / API / docs) |
| 3 | Clear disclosure of modifications, plus link to modified source when distributed externally | Forks, bundles, re-branded deployments |
| 4 | Third-party component licenses preserved (see Third-Party section) | All packages bundled via npm dependency resolution |

Clause (2) attribution text that must be displayed in the running installation:

> **OnlineWiki** — Licensed under MIT (with attribution) · © 2026 OnlineWiki Contributors · https://github.com/kooshking123/OnlineWiki

It must be reachable by a reasonable end-user action (footer, About page, Preferences, etc.) and must **not** be hidden behind a login wall if the deployment exposes any UI to anonymous or unprivileged users.

Full license text follows below.  See [LICENSE](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/LICENSE) for the canonical copy.

```
MIT License — With Attribution Requirement
(SPDX short-form: MIT WITH Attribution-3.0-OnlineWiki)

Copyright (c) 2026 OnlineWiki Contributors
Project Home: https://github.com/kooshking123/OnlineWiki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

1. The above copyright notice, this permission notice, and the attribution
   statement below (including the project home URL) shall be included in all
   copies or substantial portions of the Software, including but not limited
   to all source-code distributions, packaged distributions, binary builds,
   and Docker images.

2. ATTRIBUTION IN RUNNING INSTALLATIONS — If you deploy or distribute the
   Software in a form that makes its user interface accessible to end users
   (whether via web browser, desktop application, mobile application, API,
   or any other mechanism), you MUST prominently display the following
   attribution notice, clearly legible and reachable by a reasonable
   end-user action, in a location that is standard for attribution
   notices (such as a footer, About page, Credits page, or Preferences
   screen):

       "OnlineWiki — Licensed under MIT (with attribution) ·
        © 2026 OnlineWiki Contributors ·
        https://github.com/kooshking123/OnlineWiki"

   The attribution notice must NOT be hidden behind a login wall that is
   unavailable to anonymous or non-privileged users of the installation
   (if such users can access any part of the Software's UI).

3. MODIFICATIONS — Modified versions of the Software (including forks,
   plugin bundles, derivative works that include or link against the
   Software's source, and re-branded deployments) MUST additionally
   include a clear statement disclosing that changes were made relative
   to the original upstream distribution, along with a link to the
   modified source code when distributed outside your organisation
   (pursuant to the MIT base terms).  The notice described in clause (2)
   must still be preserved and may be supplemented with additional
   attribution text describing your modifications.

4. THIRD-PARTY COMPONENTS — This Software is distributed alongside or
   statically links a number of third-party open-source components.
   Their respective copyright notices and license terms are reproduced
   in the "Third-Party Licenses & Attribution" section of the project
   README.md and/or in the package metadata, and those terms govern the
   components to which they apply.  The attribution requirements above
   apply to the OnlineWiki work itself and do not supersede any
   attribution required by the individual third-party components'
   own licenses.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Third-Party Licenses & Attribution

OnlineWiki distributes (via npm dependency bundling) the following open-source packages. Their respective license texts and copyright notices follow below.

### Runtime dependencies

| Package | Version (range) | SPDX License | Upstream URL |
|---|---|---|---|
| **connect-flash** | `^0.1.1` | MIT | `github.com/jaredhanson/connect-flash` |
| **connect-redis** | `^7.1.1` | MIT | `github.com/tj/connect-redis` |
| **csrf-csrf** | `^4.0.3` | MIT | `github.com/Psifi-Solutions/csrf-csrf` |
| **csrf-sync** | `^4.2.1` | MIT | `github.com/Psifi-Solutions/csrf-sync` |
| **dotenv** | `^16.4.5` | BSD-2-Clause | `github.com/motdotla/dotenv` |
| **ejs** | `^3.1.10` | Apache-2.0 | `github.com/mde/ejs` |
| **express** | `^4.19.2` | MIT | `github.com/expressjs/express` |
| **express-ejs-layouts** | `^2.5.1` | MIT | `github.com/Soarez/express-ejs-layouts` |
| **express-session** | `^1.18.0` | MIT | `github.com/expressjs/session` |
| **fs-extra** | `^11.2.0` | MIT | `github.com/jprichardson/node-fs-extra` |
| **helmet** | `^7.1.0` | MIT | `github.com/helmetjs/helmet` |
| **ioredis** | `^5.4.1` | MIT | `github.com/redis/ioredis` |
| **ldapauth-fork** | `^5.0.5` | MIT | `github.com/vesse/node-ldapauth-fork` |
| **morgan** | `^1.10.0` | MIT | `github.com/expressjs/morgan` |
| **multer** | `^1.4.5-lts.1` | MIT | `github.com/expressjs/multer` |
| **passport** | `^0.7.0` | MIT | `github.com/jaredhanson/passport` |
| **passport-ldapauth** | `^3.0.1` | MIT | `github.com/vesse/passport-ldapauth` |
| **passport-local** | `^1.0.0` | MIT | `github.com/jaredhanson/passport-local` |
| **sanitize-html** | `^2.17.7` | MIT | `github.com/apostrophecms/sanitize-html` |
| **session-file-store** | `^1.5.0` | Apache-2.0 | `github.com/valery-barysok/session-file-store` |
| **slugify** | `^1.6.6` | MIT | `github.com/simov/slugify` |
| **tinymce** | `^7.1.2` | MIT OR GPL-2.0-or-later | `github.com/tinymce/tinymce-dist` |
| **winston** | `^3.19.0` | MIT | `github.com/winstonjs/winston` |
| **winston-daily-rotate-file** | `^5.0.0` | MIT | `github.com/winstonjs/winston-daily-rotate-file` |

### Development dependencies

| Package | Version | SPDX License | Upstream URL |
|---|---|---|---|
| **nodemon** | `^3.1.3` | MIT | `github.com/remy/nodemon` |

### Full license texts (packages with non-MIT / attribution requirements)

#### dotenv — BSD-2-Clause

```
BSD 2-Clause License

Copyright (c) 2015, Scott Motte
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

#### ejs — Apache-2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Copyright 2011 Matthew Eernisse (mde@fleegix.org)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

#### session-file-store — Apache-2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Copyright 2015 Valery Barysok

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

#### TinyMCE — Dual: MIT or GPL-2.0-or-later

TinyMCE is included here under the **MIT** option. If you modify and redistribute the TinyMCE editor component itself (not just the bundled npm dependency), be aware of the alternative GPL-2.0-or-later license option and its copyleft obligations.

```
TinyMCE License (MIT option chosen)
Copyright (c) 2024 Tiny Technologies, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

All MIT-licensed packages (the vast majority of the dependency list above) are redistributed under the same terms as stated in the OnlineWiki `LICENSE` file. For any packages whose individual license text is not reproduced above, the package's npm-distributed `LICENSE` / `README` file applies.
