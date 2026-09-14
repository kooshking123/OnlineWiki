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

## Setup

### 1. Copy environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in your Active Directory details:

```env
SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

LDAP_URL=ldap://your-domain-controller.example.com
LDAP_BIND_DN=cn=svc-wiki,ou=ServiceAccounts,dc=example,dc=com
LDAP_BIND_PASSWORD=your-service-account-password
LDAP_BASE_DN=dc=example,dc=com
```

> **Tip:** Set `LDAP_TLS_REJECT_UNAUTHORIZED=false` in `.env` if your domain controller uses a self-signed certificate.

### 2. Install dependencies (already done)

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
OnlineWiki/
├── server.js           — Express app, routes, LDAP auth
├── .env                — Your configuration (never commit this)
├── .env.example        — Config template
├── <DATA_DIR>/         — ★ Consolidated persistent storage (default: data/)
│   │                      Sync ONLY THIS ONE folder across servers.
│   ├── pages/          — Wiki pages stored as .json files
│   ├── uploads/        — Uploaded documents
│   ├── avatars/        — User profile avatars (circular PNGs)
│   ├── sessions/       — Session JSON files (SESSION_MODE=syncthing shares these)
│   ├── users.json      — Local user registry + roles + password hashes
│   └── settings.json   — Site title / tagline / home heading
├── logs/               — Per-instance logs (do NOT sync; LOG_DIR env)
├── views/
│   ├── layout.ejs      — Shared shell (sidebar, topbar)
│   ├── login.ejs       — AD login form
│   ├── home.ejs        — Page list with search
│   ├── page.ejs        — Page reader
│   ├── edit.ejs        — TinyMCE editor
│   ├── uploads.ejs     — Document manager
│   └── error.ejs       — Error pages
└── public/
    ├── css/style.css   — Premium dark-mode CSS
    └── js/
        ├── app.js      — Sidebar, search, shared UI
        └── editor.js   — TinyMCE init + slug + attachment picker
```

`<DATA_DIR>` is controlled by the `DATA_DIR` env var (default: `data`). Use a relative
path inside the repo, an absolute Windows drive letter (`X:\OnlineWiki-Data`), a UNC
path (`\\filer.corp\wiki$`), or a Linux mount (`/srv/onlinewiki-data`).
`LOG_DIR` is separate (default: `logs`) and must never be replicated.

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

The wiki is designed to run on multiple servers simultaneously. **All persistent state lives inside a single configurable root folder (DATA_DIR, default: `data/`)** — point SyncThing at THIS ONE FOLDER on every server, and nothing else needs syncing. Sessions, pages, uploads, avatars, the user registry, and site settings all live inside DATA_DIR, so load-balanced users never need to re-login when the LB picks a different server.

Two env vars control storage layout. Configure them on **every** node:

| Variable | Default | Sync? | Example values |
|---|---|---|---|
| `DATA_DIR` | `data` | ✅ **YES — single SyncThing root** | `data`, `X:\OnlineWiki-Data`, `\\filer.corp\wiki$`, `/srv/onlinewiki-data` |
| `LOG_DIR` | `logs` | ❌ NO — per-instance diagnostics | `logs`, `D:\Logs\OnlineWiki`, `/var/log/onlinewiki` |

On startup the banner prints both absolute paths — so you can verify at a glance that the nodes point at the right storage:
```
Persistent data (DATA_DIR=data):     C:\Apps\OnlineWiki\data
Local logs        (LOG_DIR =logs):   C:\Apps\OnlineWiki\logs
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
  ┌──────────────────────────────┐     ┌──────────────────────────────┐
  │  node server.js              │     │  node server.js              │
  │  DATA_DIR=X:\OnlineWiki-Data │     │  DATA_DIR=X:\OnlineWiki-Data │ ← SAME value
  │  LOG_DIR =D:\Logs\WikiA      │     │  LOG_DIR =D:\Logs\WikiB      │ ← DIFFERENT
  │                              │     │                              │
  │  <DATA_DIR>/pages/       ←──┼─────┼──→ <DATA_DIR>/pages/        │
  │  <DATA_DIR>/uploads/     ←──┼─────┼──→ <DATA_DIR>/uploads/      │
  │  <DATA_DIR>/avatars/     ←──┼─────┼──→ <DATA_DIR>/avatars/      │
  │  <DATA_DIR>/users.json   ←──┼─────┼──→ <DATA_DIR>/users.json    │
  │  <DATA_DIR>/settings.json←──┼─────┼──→ <DATA_DIR>/settings.json │
  │  <DATA_DIR>/sessions/*.json ←┼────┼──> <DATA_DIR>/sessions/*.json│ ← SESSIONS SYNCED
  │                              │     │                              │
  │  reaper cron: OFF            │     │  reaper cron: HOURLY (ONE!) │ ← scheduled task
  └──────────────────────────────┘     └──────────────────────────────┘
           ↕ SyncThing                                   ↕ SyncThing
   (SINGLE FOLDER: DATA_DIR  —  ignores sessions/*.tmp, sessions/*.lock,
    and any files matching the repo-root .stignore patterns when sharing
    the project folder instead of just DATA_DIR)
```

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
```powershell
# Clone / copy the project to each server
npm install                    # install deps locally — node_modules is NOT synced
Copy-Item .env.example .env    # configure each server's .env independently
```

**2. Configure `.env` identically on every server**

Set these shared values on **every** node. All of them are read from `.env` at startup; they are **not** read from DATA_DIR:

```env
# ── Storage — the ONE folder SyncThing needs to replicate
DATA_DIR=X:\OnlineWiki-Data           # SAME value on every server (mapped drive / UNC / rel)
LOG_DIR=D:\Logs\OnlineWiki            # DIFFERENT per server, or same default "logs"

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

**3. Set up SyncThing share → ONE FOLDER (DATA_DIR)**

- On **every** server, open SyncThing and add a single "Folder" entry that points to the exact same absolute path you wrote in `DATA_DIR` (e.g. `X:\OnlineWiki-Data` or `/srv/onlinewiki-data`).
- If DATA_DIR stays at the default `data` (inside the repo), you can share the whole project folder instead — the repo-level `.stignore` already excludes `node_modules`, `.env`, `logs`, and transient `sessions/*.tmp / *.lock` files.
- If DATA_DIR is a **custom absolute path** (e.g. `X:\OnlineWiki-Data`), **copy the `.stignore` file into that custom folder root** and adjust the ignore patterns to strip the leading `data/` prefix: `sessions/*.tmp`, `sessions/*.tmp.*`, `sessions/*.lock` (no `data/` prefix because the sync root IS the data root now).
- Contents that SyncThing must carry:
  - ✅ `pages/`, `uploads/`, `avatars/`
  - ✅ `users.json`, `settings.json`
  - ✅ `sessions/*.json` (the final session files — not the tmp/lock scratch!)
- Contents SyncThing must **ignore** inside the shared folder:
  - ❌ `sessions/*.tmp`, `sessions/*.tmp.*`, `sessions/*.lock`

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
```powershell
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
