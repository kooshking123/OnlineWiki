# OnlineWiki — Quick Start Guide

A lightweight, self-hosted internal collaborative wiki.

## Features

- 📝 **WYSIWYG editing** — TinyMCE 7 with light/dark theme skins (oxide / oxide-dark), tables, code blocks, media embed, and more; editor skin and content area match the user's selected UI theme
- 🔐 **AD/LDAP authentication** — login with Active Directory credentials via `ldapauth-fork`, plus optional local `.env` bootstrap admin account and local-user registry with bcrypt password hashing and role-based access control (reader / editor / administrator)
- 📁 **Flat-file storage** — pages saved as JSON in `<DATA_DIR>/pages/` (configurable single sync root), no database required; every piece of persistent state lives inside exactly one `DATA_DIR` folder for trivial SyncThing / DFS replication
- 📂 **Uploads folder hierarchy (up to 8 nested levels)** — Documents area supports physical sub-folders on disk (not virtual metadata). Create/rename/delete folders in-browser; move selected files between folders via toolbar + batch modal; breadcrumb navigation + sidebar tree view in the TinyMCE file picker. SyncThing replicates the real directory tree across servers exactly as it appears on disk.
- 🗂️ **Folder-aware TinyMCE attachment picker** — Quick Media Insert image/file browser exposes a two-pane layout: (A) sidebar folder tree with untracked count badges + empty-state indicators, (B) main area with breadcrumb, folder-entry cards, file grid, and full-text search. Click a folder to descend, breadcrumb to climb back up; files in nested subfolders are served via URI-encoded per-segment wildcard routes so spaces and special characters resolve correctly.
- 🚨 **Bidirectional orphan upload detection & repair** — the Documents page continuously scans for **both** integrity failure directions and offers one-click repair:
  - **Type A (orphan files):** files present on disk but missing from the uploads index → shown with ⚠ amber badge; Adopt (creates index record from stat birthtime/size/uploader) or Delete (permanent disk erase) per-row + **Adopt All** batch toolbar button.
  - **Type B (dangling records):** entries present in uploads.json but missing from disk → shown with 🗑️ red badge in a dedicated dangling tbody section; hidden from the TinyMCE picker via a triple-lock (server filtered, client JS filtered, CSS display:none); per-row **Remove Record** + **Prune Dangling** folder-scoped + **Global Prune Dangling** (all folders in one click) toolbar buttons, with automatic page attachment array cleanup so pages never reference 404'd deleted uploads.
  - Header count pills (`⚠ N untracked · 🗑️ M dangling`) always show current totals; zero-state completely hides all orphan callouts and disables batch buttons automatically.
- 🎨 **Customizable branding** — administrators can upload a custom site logo (PNG / JPEG / WebP / SVG, max 2 MB) from **Settings → Branding**; shown in the sidebar header (top-left) *and* on the unauthenticated login screen; public `/logos/` route serves the logo without requiring auth. Falls back to a books emoji if unset. Site title, tagline, and home heading/subtitle are also editable via the same admin UI
- 🌗 **Per-user light/dark theme switch** — every authenticated user self-selects a light or dark UI theme (default = light for all new users). Persisted server-side in the user registry (`users.json[].theme`) + fast-path cookie for FOUC-free 1st paint; TinyMCE editor chrome + content area switch skins synchronously. Login screen uses an independent neutral brand theme (not user theme)
- 🧱 **Hierarchy restructuring** — editors can promote / demote pages (move up/down a level) and reorder pages among siblings via a 4-button cluster on the page viewer. Cycle guards prevent invalid hierarchies; every mutation updates `updatedAt` and writes an audit event. Home cards and "In This Section" children both expose the same inline reorder controls
- 🛡️ **Duplicate title guard + one-click save parity** — saving a page whose title collides with an *existing different page* shows a synchronous confirmation dialog BEFORE the POST is sent. **The server-side `confirmDuplicate` gate now exactly mirrors the client predicate (`titleActuallyChanged`):** re-renders are skipped when only the body changed, removing the prior "double-click to save" footgun. Save buttons use `type="button"` + TinyMCE `triggerSave()` + 60 ms TinyMCE-skin-reload guard + direct `form.submit()` to eliminate browser async-submit races and editor state staleness.
- 📎 **Document uploads** — attach PDF, Word, Excel, PowerPoint and other files; download to view; Quick Media Insert sidebar panel in the editor embeds images or links to files inline
- 👥 **User Management (admins only)** — `/admin/users` UI to create/delete local users, assign roles (reader/editor/administrator), reset passwords, and upload custom profile avatars. Roles gate: readers = view only; editors = create/edit/delete pages + uploads + folder ops + orphan repair; administrators = user management + site settings
- ⚙️ **Site Settings (admins only)** — `/admin/settings` single-form configuration of site title, tagline, home heading/subtitle, custom site logo (upload/remove), registration policy, and more. Stored atomically in `data/settings.json` (no database), changeable via CSFR-safe POST with audit logging
- 🔍 **Live search** — filter pages and uploads (and dangling upload records) instantly in the browser sidebar (client-side, no network round-trip)
- 🌙 **Modern UI** — glassmorphism neutral-theme login screen, animated collapsible sidebar, responsive layout, custom JS-rendered tooltips (factually concise, positioned above the cursor; blue primary action buttons intentionally exclude tooltips per UX policy)

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
        │         logos/, sessions/*.json,        │          .stignore at
        │         users.json, settings.json       │          DATA_DIR/.stignore
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
│   ├── uploads/         Physical folder tree (up to 8 nested levels) of binary
│   │   │                 documents + images.  Directory structure under
│   │   │                 uploads/ is the authoritative folder hierarchy
│   │   │                 (not metadata — SyncThing replicates it as-is).
│   │   ├── Engineering/   Example user-created folder (via New Folder UI)
│   │   │   ├── Specs/       Sub-folder (files in here are served via the
│   │   │   └── ...          /uploads/* wildcard — path segments URI-encoded
│   │   ├── Test/          individually so spaces + Unicode resolve correctly)
│   │   └── ...
│   ├── uploads.json      Single authoritative index of uploads metadata:
│   │                      { version: 1, uploads: [ { storedName, originalName,
│   │                        folderPath, mimeType, size, uploadedBy, uploadedAt } ] }
│   │                      Writes atomic (tmp + renameSync), SyncThing-replicated.
│   │                      Used for orphan detection: ⚠ disk files without a
│   │                      record are "orphans"; 🗑️ records without a disk file
│   │                      are "dangling" (see bidirectional integrity repair).
│   ├── avatars/         Per-user profile pictures (circular PNG/JPG, auth-gated serve route)
│   ├── logos/           Administrator-uploaded custom site logos (PNG/JPEG/WEBP/SVG, PUBLIC serve route `/logos/` so the unauthenticated login page can render them without a 401. Auto-cleaned on replace/remove)
│   ├── sessions/        Session files (only *.json are synced; *.tmp / *.lock ignored)
│   ├── users.json       Local user registry + role map + bcrypt hashes + per-user theme field: `{ username, passwordHash, displayName, email, role, avatar, theme: "light"|"dark" }`
│   └── settings.json    Site settings: `{ siteTitle, siteTagline, homeHeading, homeSubtitle, logo: null | "<filename in logos/>.ext" }` (additive schema, no migrations; unknown values are coerced to safe defaults at read time)
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
                │  · Syncs:  pages/, uploads/, avatars/, logos/, sessions/*.json, users.json, settings.json   │
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

Each page is exactly one file: `<DATA_DIR>/pages/<slug>.json`. All writes use the pattern `write-tmp → fs.renameSync` (atomic rename-on-close) so interrupted writes never leave a partially-written valid JSON file. SyncThing conflict copies (`<slug>.sync-conflict-<ts>-<devId>.json`) are silently filtered out of `listPages()` results.

```json
{
  "title": "Getting Started",
  "slug": "getting-started",
  "parent": null,
  "position": 0,
  "content": "<p>HTML from the TinyMCE editor — sanitized server-side via sanitize-html before write…</p>",
  "tags": ["setup", "onboarding"],
  "author": "jdoe",
  "authorDisplay": "Jane Doe",
  "createdAt": "2026-09-02T02:00:00.000Z",
  "updatedAt": "2026-09-02T04:00:00.000Z",
  "attachments": ["1725235200000_User_Guide.pdf"]
}
```

Field reference:

| Field | Type | Notes |
|---|---|---|
| `title` | string | Human-readable, shown in UI. Need not be unique; duplicate titles trigger the duplicate-title guard (see Admin Guide). |
| `slug` | string | URL-safe, derived from `title` via `slugify` (lowercase, hyphenated). Must be unique across all pages (enforced server-side on save). |
| `parent` | `null` \| string | `null` = root-level page. Otherwise = `<parent-slug>` (reference to another page JSON's slug field). |
| `position` | integer | Dense ordering index within the current parent's children, 0-based. Normalized to dense `0..n-1` on every hierarchy mutation so gaps are transient. Undefined in legacy files → sort treats it as `9999` (end of list). |
| `content` | string | HTML from TinyMCE; server-sanitized through `sanitize-html` before every write (script tags, event handlers, and off-origin `<iframe>` objects are stripped). |
| `tags` | string[] | Free-form tags; displayed on cards and searchable (client-side) via the sidebar filter. |
| `author` | string | Username (LDAP sAMAccountName or local username) of the creator. |
| `authorDisplay` | string | Friendly display name of the creator (copied at creation time; not auto-updated if user later changes their display name). |
| `createdAt` | ISO-8601 string | Timestamp of the first save (never changes). |
| `updatedAt` | ISO-8601 string | Updated on every save, rename, slug change, OR hierarchy mutation (promote/demote/up/down) so reordering shows up correctly in sort-by-recent views. |
| `attachments` | string[] | Filenames within `<DATA_DIR>/uploads/` referenced by this page; Quick Media Insert in the editor appends to this array, and page-view delete-page cascades a delete of files here. |

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
- ✅ `pages/`, `uploads/`, `avatars/`, `logos/` (logos/ is required so every node renders the admin-uploaded custom site logo on the sidebar AND the unauthenticated login screen; the `/logos` serve route is public)
- ✅ `users.json`, `settings.json` (settings.json carries the `logo` filename pointer that references a file in logos/)
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

## Uploading Documents & Folder Management

### Upload basics

1. Open **Documents** in the sidebar.
2. Navigate into any existing sub-folder first (if desired) — new uploads land in whatever folder the breadcrumb shows.
3. Drag & drop, or click **Choose File** — supported types: PDF, Word, Excel, PowerPoint, images, ZIP, CSV (max 50 MB per file).

### Folder hierarchy (physical directories on disk)

- **New Folder** toolbar button → creates a real physical subdirectory under `<DATA_DIR>/uploads/`.
- **Rename / Delete** folder (per-row buttons) → same-named filesystem operations; deleting a non-empty folder is rejected server-side (emptied it first).
- **Move selected files** toolbar button → multi-select checkboxes in the file rows become actionable once ≥1 file selected; modal folder picker + confirm moves files (and their uploads.json records, plus page-attachment path updates) atomically. Cycle guard prevents moving a file into a folder where the exact same storedName already exists.
- Breadcrumb bar at the top of the Documents main area lets you climb back up any depth level; TinyMCE's attachment picker mirrors the same breadcrumb + folder tree.
- Up to 8 levels of nesting are enforced server-side via `normalizeAndValidateFolderPath`; attempts to go deeper return a 400 error.

### Integrating uploads into pages (folder-aware picker)

Open any page editor → **Quick Media Insert** sidebar panel. The Insert Image / Insert Link to File dialog now exposes:

- **Sidebar folder tree** (left pane) — click any folder to jump to it directly; tree nodes include `(N)` file-count chips + empty-state indicators for leaf directories that contain no files but do have sub-folders.
- **Main area (right pane)** — folder-entry cards (click to descend) + file list with thumbnails for images + preview icons for PDFs/docs + per-row insert buttons.
- Full-text search across both the current folder's files and its sub-folder contents at the top of the dialog.
- Nested-file download URLs are automatically URI-encoded per path segment so spaces, `&`, `#`, and Unicode characters resolve correctly through the wildcard `/uploads/*` static-serve middleware.

### Orphan & dangling upload integrity repair (editors +)

Every Documents page render performs a **bidirectional 2-way set-diff** between what actually exists on disk and what the uploads index says should exist:

| State | Badge | Root cause | How to repair |
|---|---|---|---|
| **Orphan file (disk but no index)** | ⚠ amber "Untracked" | File was added directly to `<DATA_DIR>/uploads/` via SyncThing, rsync, Explorer drag-in, etc. — nothing ever wrote a matching index entry. So page attachments can't reference it, the move modal skips it, and audit logs can't track it. | **Adopt** per-row → creates an uploads.json record using the file's actual `stat.birthtime`, byte size, and the current user as the uploader. Or **Delete** per-row → deletes the disk file permanently (same confirm flow as normal files). Or **Adopt All** toolbar → one POST adopts every orphan in the current folder in a batch. |
| **Dangling record (index but no disk file)** | 🗑️ red "Dangling" | File was manually deleted from `<DATA_DIR>/uploads/` outside the UI, or a SyncThing conflict resolved to the deleted side; or the page attachment pointed at a file that never fully replicated — leaving a stale 404 pointer in `uploads.json` + potentially in every page `attachments[]` array that references it. | **Remove Record** per-row → deletes the single stale index entry *and* scans every page JSON `attachments[]` array, removing references to the dangling storedName + relPath. Or **Prune Dangling** toolbar → batch removes every dangling record in the current folder with the same attachment cleanup, or click **Global Prune Dangling** (danger variant) to scan *all* folders in one click. |

Counts are always shown next to the Documents subtitle as `⚠ N untracked · 🗑️ M dangling` and a dual-card callout banner renders between the header and the upload dropzone whenever either count > 0. When both hit 0, all badges, the callout, and all batch toolbar buttons auto-disable. Dangling records are **never** shown in the TinyMCE picker — protected by a triple lock (server filtered from the flat API, client JS filtered in both flat and folder render paths, CSS `.attach-picker-item.is-dangling` display:none as a catch-all).

### Audit trail for repair operations

All six repair actions write distinct, searchable audit events to `<LOG_DIR>/audit-YYYY-MM-DD.log`:

| Action | Audit event |
|---|---|
| Adopt single orphan | `FILE_ADOPTED` |
| Adopt All (batch) | `ORPHAN_BATCH_ADOPTED` — includes count of how many records were created |
| Delete orphan file | `FILE_DELETED` — with `orphan: true` metadata |
| Remove Record single dangling | `DANGLING_RECORD_REMOVED` — includes storedName + relPath |
| Prune Dangling / Global Prune Dangling (batch) | `DANGLING_BATCH_PRUNED` — includes count removed + scope |

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
     ADMINISTRATION · Day-to-day operations guide
     How to use the admin-exclusive features, manage branding, users,
     theme, hierarchy, and understand the duplicate-title safety model.
     ═══════════════════════════════════════════════════════════════════════ -->

## Administration & Operations Guide

All tasks in this section require the `administrator` role unless otherwise stated.

### Site Branding (admins only)

Navigate to **Settings → Branding** (`/admin/settings`). All changes take effect immediately and are written atomically to `DATA_DIR/settings.json` (no server restart required; every node picks them up on the next HTTP request via `loadSettings()`).

| Setting | Where it appears | Notes |
|---|---|---|
| **Site title** | Sidebar header (next to logo), browser `<title>`, login screen heading, email/notifications | Max 80 characters |
| **Site tagline** | Login screen subtitle, HTML `<meta name="description">` | Sentence case; shown under the title on login |
| **Home heading** | Home page top banner | Supports `{N}` placeholder (replaced with total page count) and `{N_S}` (plural "s" when N ≠ 1) |
| **Home subtitle** | Home page second-line text | Same `{N}` / `{N_S}` placeholders |
| **Site logo** | Sidebar header (top-left, 28×28 px) + unauthenticated login screen (max 96×80 px) | PNG / JPEG / WebP / SVG (SVG recommended for sharpness on retina). Max 2 MB. Upload replaces the previous file (auto-deleted). Remove reverts to the built-in 📚 books emoji in both locations. The logo file is stored at `<DATA_DIR>/logos/logo-<timestamp>.<ext>` and served publicly via the unauthenticated `/logos/<filename>` route (unlike `/avatars` which is auth-gated — the login page must be able to load it without a session). |

> **SyncThing note for multi-server**: When you upload or remove a logo, SyncThing must replicate BOTH the `logos/` directory contents AND the `settings.json` pointer file. If you see a broken-image 404 on one node, wait for SyncThing to converge (usually a few seconds) — the TEMPLATE B `.stignore` is pre-configured to sync both locations correctly.

### Theme System

Two themes are available plus a standalone login theme:

| Context | Theme | Scope | How to change |
|---|---|---|---|
| **Authenticated pages** (sidebar, home, page view/edit, profile, admin) | `light` or `dark`, per-user | Users self-select; default = `light` for all new users | Topbar sun/moon selector (left of user chip) **or** My Profile → Preferences → Theme radio swatches |
| **Login screen** (unauthenticated) | `neutral` (blue/purple brand gradient, slate-900 text, white card) | Hard-coded, identical for all visitors | Cannot be changed by users; deliberately decoupled so a user with `dark` theme selected does not "leak" their preference to the shared kiosk login screen |

**Technical implementation notes:**
- Persisted server-side in `users.json[<username>].theme` (string, `"light"` \| `"dark"` — any other value coerces to `"light"` at read time).
- Fast-path non-HttpOnly 30-day `theme` cookie written on every change/save so an inline script in `<head>` (before CSS) sets `html.theme-*` **before the first paint**, eliminating FOUC.
- If a user changes theme on a page that has TinyMCE 7 editor open, a `hasTinyMCE()` helper detects the editor's presence and triggers a 60 ms delayed page reload — TinyMCE cannot hot-swap skins at runtime, so a reload is required to re-initialize the correct `oxide` / `oxide-dark` skin + `default` / `dark` content_css pair. Pages without TinyMCE (Home, profile, Settings, page viewer) update instantly without reload.
- Legacy users who have no `theme` field in their record are treated as `light` at deserialization (no data migration script needed; lazily back-filled on first profile write or theme switch).

### User Management (admins only)

Open **User Management** in the sidebar (`/admin/users`).

| Action | How |
|---|---|
| **Create local user** | "Create user" blue button → fill username, display name, email (optional), password, role (reader / editor / administrator). BCrypt hash is written at save time. |
| **Edit / reset password** | Click a user row → edit fields + new password (blank = leave unchanged). Password is re-hashed only when a non-empty value is submitted. |
| **Change role** | Reader = view only; Editor = create/edit/delete pages, upload files, reorder hierarchy; Administrator = all of the above + user management + site settings. Roles take effect on the next request (no logout needed). |
| **Delete user** | Red trash button → confirmation. LDAP-mapped users can still log back in and re-create their record via the LDAP upsert flow; purely-local users are gone permanently. |
| **Upload profile avatar** | Users themselves (not admins) manage avatars from **My Profile** → avatar card. PNG/JPG circular crop, max 2 MB, stored auth-gated at `<DATA_DIR>/avatars/<user>-<timestamp>.<ext>`. |

### Hierarchy & Page Reordering (editors+; admins inherit)

Every page in the wiki lives in a tree: root pages (top-level) have `parent: null`; child pages store `parent: "<parent-slug>"`. Siblings at each level are ordered by their integer `position` field (dense 0..n-1; normalized on every move operation so gaps never persist).

**Four affordances on the page viewer header (reorder cluster, always visible; invalid actions disabled and greyed out, never hidden):**

| Button | Action | Disabled when |
|---|---|---|
| **← Promote** | Move this page up one level (its parent becomes its grandparent; `parent = oldParent.parent`) | Already a root page (`parent: null`) — cannot go higher |
| **→ Demote** | Move this page down one level, becoming the last child of its **current preceding sibling** | No preceding sibling (it's the first child of its parent) OR preceding sibling has cycle risk — cycle guard on server prevents creating loops |
| **↑ Up** | Swap `position` with the preceding sibling among its current parent's children | First child of its level (`position: 0`) |
| **↓ Down** | Swap `position` with the next sibling among its current parent's children | Last child of its level (`position = siblings.length - 1`) |

**Additional inline reorder locations:** Home page top-level cards expose ↑↓ in the card footer; "In This Section" child cards on the page viewer expose ↑↓ on hover. All mutations go through `POST /pages/:slug/move` behind `ensureRole('editor')` with CSRF tokens and an optional same-origin `redirect` body field so the user lands back on the same scroll anchor they started from.

Every hierarchy mutation:
1. Updates the page's `updatedAt` timestamp.
2. Detects and refuses cycles (e.g. demoting a page into one of its own descendants).
3. Writes a `PAGE_UPDATED` audit event with `{ hierarchyChanged: true, action: promote\|demote\|up\|down }` to the daily audit log.

### Duplicate-Title Save Guard + one-click save parity (for editors / admins)

When saving a page (new or edit) whose **title** collides with another page (different slug), the following layered guard runs to prevent accidental overwrites:

```
┌────────────────────────────────────────────────────────────────────┐
│  LAYER 1 · Client-side synchronous gate (editor.js)                │
│  Save button uses type="button" (NOT type="submit") — browsers do  │
│  not fire the async HTML-form-submission algorithm at all. The     │
│  click handler does e.preventDefault() then:                       │
│    1. tinymce.triggerSave() → copies editor content into <textarea>│
│    2. Builds a duplicate-check request, or uses inline list if     │
│       available.  **Duplicate dialog ONLY fires when the title     │
│       ACTUALLY CHANGED (titleActuallyChanged client check).**      │
│       Body-only edits skip confirm entirely.                       │
│    3. window.confirm("Another page already has this title…") —     │
│       100% synchronous blocking; nothing proceeds until user       │
│       clicks OK / Cancel                                            │
│    4. Only if user confirms OK → raw pageForm.submit() (NOT        │
│       requestSubmit; no submit event fires; no racing listeners)   │
│       with confirmDuplicate=true embedded in the POST body         │
│  + TinyMCE-skin reload guard: 60 ms delay before final submit()    │
│    when theme just changed, because oxide↔oxide-dark cannot hot-   │
│    swap at runtime.  Eliminates a double-submit false-positive.    │
├────────────────────────────────────────────────────────────────────┤
│  LAYER 2 · Server-side enforcement (server.js POST /pages/save)    │
│  **Server mirrors the client predicate EXACTLY:**                  │
│    i. Compute `titleActuallyChanged` against the persisted page.   │
│   ii. If the title DID NOT CHANGE (e.g. body-only edit):           │
│         duplicate guard is SKIPPED ENTIRELY → save is direct,      │
│         re-render bypassed, ONE CLICK = ONE SAVE.                  │
│  iii. If title actually collides with a DIFFERENT page slug:       │
│         a. confirmDuplicate === "true" → save proceeds             │
│         b. confirmDuplicate missing / any other value → save is    │
│            REFUSED, edit form re-RENDERED INLINE (not a 302 so the │
│            user's TinyMCE draft + all form fields are preserved)   │
│            with flash error.  This parity check eliminates the     │
│            legacy "must double-click to save" bug that occurred    │
│            when the server fired duplicate gates on unchanged      │
│            titles but the client did not.                          │
│  Tamper guard:  Layer 2 cannot be bypassed even if the client JS   │
│  is patched, because Layer 2 is the sole arbiter of actual writes. │
└────────────────────────────────────────────────────────────────────┘
```

### Uploads Index Wire Format + page attachment semantics

Each upload gets exactly one entry in `<DATA_DIR>/uploads.json` (a single file, not a per-file metadata). The entire index is read once per request via `readUploadsIndex()` and writes are atomic (`writeUploadsIndex` does write-tmp + `fs.renameSync`). SyncThing replicates `uploads.json` the same way it replicates page JSON files.

Structure of `<DATA_DIR>/uploads.json`:

```json
{
  "version": 1,
  "uploads": [
    {
      "storedName": "1788404759251__SA__Chengdu__Chongqing_Duo-Cities.pdf",
      "originalName": "_SA__Chengdu__Chongqing_Duo-Cities.pdf",
      "folderPath": "",
      "mimeType": "application/pdf",
      "size": 1048576,
      "uploadedBy": "jdoe",
      "uploadedAt": "2026-09-03T02:00:00.000Z"
    },
    {
      "storedName": "9999999_orphan-test-file.txt",
      "originalName": "orphan-test-file.txt",
      "folderPath": "Engineering",
      "mimeType": "text/plain",
      "size": 109,
      "uploadedBy": "admin",
      "uploadedAt": "2026-09-18T02:00:00.000Z",
      "orphan": false,
      "recordMissing": false
    }
  ]
}
```

| Field | Required? | Meaning |
|---|---|---|
| `storedName` | yes | Basename on disk inside `<DATA_DIR>/uploads/<folderPath>/`. Must be unique within its folder (server rejects colliding move/upload ops). |
| `originalName` | yes | User-facing name (the filename the client actually chose at upload time). Shown in table Name column, download filename, and picker cards. |
| `folderPath` | yes | Empty string `""` = root level. Otherwise = `/`-separated *relative* path from `uploads/` with NO leading or trailing slashes (e.g. `"Engineering/Specs"`). |
| `mimeType` | yes | Detected at upload time; used for `Content-Type` on download. |
| `size` | yes | Bytes, shown in Size column. |
| `uploadedBy` | yes | sAMAccountName / local username. Shown in audit + used as default for batch adopt when no other user available. |
| `uploadedAt` | yes | ISO-8601 UTC timestamp. Adopt operations use the file's real `stat.birthtime`; fresh uploads use `Date.now()` ISO. |
| `orphan` | no, transient | Transient SSR / API flag: `true` when file exists on disk but no index entry matched. |
| `recordMissing` | no, transient | Transient SSR / API flag: `true` when index entry exists but `storedName` is missing from disk. **Never emitted to the flat `/api/uploads` picker API.** |

A page's `attachments[]` array (per page JSON, see [Page Storage Wire Format](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/README.md#L280-L316)) stores the raw `storedName` for **root-level files**, and stores `"<folderPath>/<storedName>"` for **nested files**. The view-layer download helper splits on the last `/` to reconstruct the correct route. Prune/Remove dangling-record operations run `listPages()` and filter attachments with O(1) lookups using a `Set()` of both `storedName` and the combined `folderPath + '/' + storedName`, so both flat and nested references are cleaned atomically.

### Silent Deprecation Warnings (ops note)

`connect-flash@0.1.1` (abandoned upstream, 2013) captures a reference to the Node.js core `util.isArray` API at `require` time. In modern Node (20+), this triggers a `DEP0044` deprecation warning once per process startup. To keep logs noise-free without upgrading the package (it would break the flash-messaging contract used across all templates), `server.js` applies a one-line monkey-patch at lines 4–17 (immediately after `dotenv` is loaded, BEFORE any `require` of `connect-flash` or middleware that depends on it):

```js
const util = require('util');
if (!util.isArray) util.isArray = Array.isArray;
```

Behavior is mathematically identical (`Array.isArray` is the modern replacement the deprecation message recommends); no flash messages are affected. If you ever upgrade to a maintained fork of `connect-flash` (or replace it), you can safely delete those 3 lines.

### HTTP + HTTPS Dual-Stack & TLS Setup

OnlineWiki supports **three deployment modes** — pick the one that matches your network topology. HTTPS is OPTIONAL; HTTP is always enabled and is the default if no PEM paths are set.

| Mode | When to use | How to configure |
|---|---|---|
| **HTTP only (default)** | Dev; or behind a TLS-terminating reverse proxy (nginx / Caddy / AWS ALB / Cloudflare). | Leave all `SSL_*` vars unset. HTTP listener on `PORT` (default 3000). Let the upstream proxy terminate TLS and forward plain HTTP to the wiki — `app.set('trust proxy', ['loopback','linklocal','uniquelocal','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'])` is pre-configured so session `Secure` cookies (in `NODE_ENV=production`), `req.secure`, and the redirect logic correctly see proxied-HTTPS as secure via `X-Forwarded-Proto` + `X-Forwarded-Host` from the fronting load balancer. |
| **Dual HTTP + HTTPS listeners** | Bare-metal or direct-access production where the wiki itself terminates TLS (no fronting proxy). | Set both `SSL_CERT_PATH` AND `SSL_KEY_PATH` to PEM file paths (absolute or relative to `process.cwd()`; relative paths are resolved by `server.js:_resolveTlsPath()`). The wiki starts **two listeners** on the same Express app: one plain HTTP on `PORT` (default 3000), one TLS on `HTTPS_PORT` (default 3443). |
| **HTTPS-only (redirect)** | Dual-stack mode but you want every accidental plaintext click to jump to HTTPS. | Add `HTTPS_REDIRECT_HTTP=true` (default: `false`). Safe HTTP methods **GET/HEAD** arriving on the plaintext listener that carry a `Host` header are rewritten into a **301 Moved Permanently** redirect to `https://<host>:<HTTPS_PORT><path>` with a `Strict-Transport-Security: max-age=31536000; includeSubDomains` response header. POST/PUT/PATCH bodies are never redirected (browsers drop bodies across 30x); send forms over the canonical HTTPS URL. |

**Typical port combinations**:

| Scenario | `PORT` | `HTTPS_PORT` | Notes |
|---|---|---|---|
| Local dev / non-admin run | 3000 | 3443 | Non-privileged ports, works on Windows/macOS/Linux user accounts with no elevation. |
| Bare-metal production (direct) | 80 | 443 | Run the process with `CAP_NET_BIND_SERVICE` on Linux, or a Windows service account with `SeSecurityPrivilege` for low-port bind. |
| Behind nginx / ALB / CF | 3000 | *(unset)* | Proxy terminates TLS; upstream forwards plain HTTP. The wiki doesn't even load the TLS codepath (no `https` require overhead when `SSL_*` blank). |

---

#### Linux / Let's Encrypt (certbot) — Ubuntu/Debian bare-metal

DNS record `wiki.example.com` → public IP of the server; port 80 reachable from the internet for the standalone HTTP-01 challenge.

```bash
# 1. Issue or renew a certificate (standalone mode). Post-renewal hook should restart
#    the wiki systemd unit so the node process re-reads the rotated PEM files.
sudo certbot certonly --standalone -d wiki.example.com \
  --deploy-hook "systemctl restart onlinewiki.service"

# 2. Copy into a location the wiki service account can read (letsencrypt live dir
#    is root-only by default — don't chown the /etc/letsencrypt hierarchy itself).
sudo install -d -m 755 /etc/ssl/private /etc/ssl/certs
sudo install -m 600 -o wiki -g wiki \
  /etc/letsencrypt/live/wiki.example.com/privkey.pem  /etc/ssl/private/wiki-onlinewiki-key.pem
sudo install -m 644 -o wiki -g wiki \
  /etc/letsencrypt/live/wiki.example.com/fullchain.pem /etc/ssl/certs/wiki-onlinewiki-fullchain.pem
```

…then in `.env`:

```dotenv
PORT=80
HTTPS_PORT=443
SSL_CERT_PATH=/etc/ssl/certs/wiki-onlinewiki-fullchain.pem
SSL_KEY_PATH=/etc/ssl/private/wiki-onlinewiki-key.pem
HTTPS_REDIRECT_HTTP=true
# Optional: extra private-CA intermediate chain
# SSL_CA_PATH=/usr/local/share/ca-certificates/corp-intermediate.crt
```

If you use a private internal CA whose root isn't in the Mozilla store, bundle the intermediate(s) into a single PEM file and set `SSL_CA_PATH` so Node's TLS stack advertises the full chain to clients.

---

#### Windows local dev — self-signed SAN cert (the setup applied to this repo's `.env`)

OpenSSL ships with **Git for Windows** at `C:\Program Files\Git\usr\bin\openssl.exe`. A standalone OpenSSL installer (`C:\Program Files\OpenSSL-Win64\bin\openssl.exe`) or Chocolatey `choco install openssl.light` also work. The one-liner below uses an inline SAN config because older Git-OpenSSL builds don't support the `-addext` CLI flag:

```powershell
# Create an OpenSSL config that declares DNS:localhost + both loopback IPs, then sign.
@'
[ req ]
default_bits       = 2048
distinguished_name = dn
x509_extensions    = v3_ca
prompt             = no
[ dn ]
CN = localhost
O  = OnlineWiki Local Dev
C  = US
[ v3_ca ]
basicConstraints = CA:FALSE
keyUsage         = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName   = @alt
[ alt ]
DNS.1 = localhost
DNS.2 = localhost.localdomain
IP.1  = 127.0.0.1
IP.2  = ::1
'@ | Set-Content data\dev-tls-openssl.cnf -Encoding ASCII

& 'C:\Program Files\Git\usr\bin\openssl.exe' req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes `
  -config data\dev-tls-openssl.cnf -extensions v3_ca `
  -keyout data\dev-tls-key.pem -out data\dev-tls-cert.pem
```

Verify the 4 SANs actually embedded (Chrome/Edge require at least one matching SAN; a bare `CN=` no longer counts):

```powershell
& 'C:\Program Files\Git\usr\bin\openssl.exe' x509 -in data\dev-tls-cert.pem -noout -ext subjectAltName
# → X509v3 Subject Alternative Name:
#      DNS:localhost, DNS:localhost.localdomain, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1
```

…then the matching `.env` block (already applied in this repo):

```dotenv
PORT=3000
HTTPS_PORT=3443
SSL_CERT_PATH=data/dev-tls-cert.pem
SSL_KEY_PATH=data/dev-tls-key.pem
HTTPS_REDIRECT_HTTP=false
```

**Trusting the self-signed cert on this Windows PC (admin once)**. If you want a real green lock instead of the "Not Secure" warning, double-click `data\dev-tls-cert.pem` in Explorer → **Certificate → Install Certificate → Local Machine → Next → Place all certificates in the following store → Browse → Trusted Root Certification Authorities → OK → Next → Finish → "The import was successful"**. Close and re-open Chrome/Edge. Navigate to `https://localhost:3443/` → the lock icon will now show a valid "Issued to: localhost" cert.

> ⚠️ **Multi-server / SyncThing caveat for local-dev certs**: if you set `DATA_DIR=data` and SyncThing replicates it, **add `data/dev-tls-*.pem` and `data/dev-tls-openssl.cnf` to the `.stignore` of every SyncThing node**. Each machine must have its *own* self-signed cert/key pair — sharing the same private key across hosts is a bad security habit and will break host-name matching when the cert's SANs bind to localhost only. Production certs (with public DNS names) obtained from a real CA, in contrast, SHOULD be synced so every frontend on the cluster advertises the same chain.

---

#### Graceful shutdown & signal handling

`SIGTERM` / `SIGINT` ([server.js:3033–3045](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L3033-L3045)) call `.close()` on both the HTTP and HTTPS listeners in parallel so no new TCP accepts are opened, wait for in-flight requests to drain up to Node's default keep-alive window, then give the winston file-transport 400 ms to flush its final audit-line to disk before exiting. This matches the contract that `systemd stop` / `docker stop` / Kubernetes `terminationGracePeriodSeconds` rely on: no log line is lost, and no `502 Bad Gateway` leaks through the load balancer during rolling restarts. On Windows, `Ctrl+C` at the console issues a `SIGINT` and triggers the same drain path.

| Signal | Source | Behaviour |
|---|---|---|
| `SIGINT`  | `Ctrl+C` (any OS terminal) | Graceful close both servers + flush → exit 0 |
| `SIGTERM` | systemd, Docker stop, kubelet 1.20+ | Same drain as SIGINT → exit 0 |
| `SIGKILL` | `kill -9` / taskkill /F | Hard kill; last 400 ms of log lines may be lost (never use for normal restarts). |

---

## Audit Event Reference

All mutation operations write a structured JSON audit event to `<LOG_DIR>/audit-YYYY-MM-DD.log` (one event per line, NDJSON, ingestible by Splunk / ELK / Seq / Datadog). Every event has at minimum `{ at, event, by, ip }`. The scenario harness (T9) requires **≥ 6 distinct audit types** — in practice the application currently emits **14 distinct types**, including 4 for orphan upload integrity repair.

| event | Written when | Fields (beyond base) | Role required |
|---|---|---|---|
| `USER_LOGIN` | Successful LDAP or local auth | `{ method: "ldap" \| "local" }` | — (login endpoint) |
| `USER_LOGOUT` | Manual sign-out or idle-time auto-signout | `{ reason: "manual" \| "inactive" }` | authenticated |
| `USER_CREATED` | Admin creates local user in `/admin/users` | `{ username, role, displayName }` | administrator |
| `USER_UPDATED` | Admin edits display name / email / role / password reset | `{ username, changed: ["role","password","displayName",...] }` | administrator |
| `USER_DELETED` | Admin deletes local user | `{ username }` | administrator |
| `PAGE_CREATED` | New page saved (POST /pages/save with no slug) | `{ slug, title, parent, position }` | editor |
| `PAGE_UPDATED` | Any page save, title change, slug change, hierarchy mutation | `{ slug, title, parent, position, contentChanged, titleChanged, hierarchyChanged?, action?, confirmDuplicate? }` | editor |
| `PAGE_DELETED` | Page removed from disk | `{ slug, title, attachmentsDeletedCount }` | editor |
| `FILE_UPLOADED` | Upload dropzone accepted a file | `{ storedName, originalName, folderPath, size, mimeType }` | editor |
| `FILE_DELETED` | Single file delete (or orphan file deleted) | `{ storedName, folderPath, orphan: true \| false }` | editor |
| `FOLDER_CREATED` / `FOLDER_RENAMED` / `FOLDER_DELETED` | Documents folder mutations | `{ folderPath, newName? }` | editor |
| `FILES_MOVED` | Batch move selected files to a different parent folder | `{ moved: [ { storedName, oldFolder, newFolder }... ], total }` | editor |
| `SETTINGS_UPDATED` | Admin save in `/admin/settings` (branding, tagline, logo) | `{ changed: ["siteTitle","logo","registrationPolicy",...] }` | administrator |
| `FILE_ADOPTED` | Per-row adopt of an orphan disk file → creates index record | `{ storedName, folderPath, size, uploadedAt }` | editor |
| `ORPHAN_BATCH_ADOPTED` | Toolbar Adopt All (folder scoped) | `{ folderPath, adoptedCount }` | editor |
| `DANGLING_RECORD_REMOVED` | Per-row Remove Record single dangling | `{ storedName, folderPath, pagesReferencedCleaned }` | editor |
| `DANGLING_BATCH_PRUNED` | Toolbar Prune Dangling (folder) or Global Prune Dangling | `{ scope: "folder" \| "global", folderPath?, removedCount, attachmentsCleaned }` | editor |

Quick grep patterns for on-call triage (Windows PowerShell):

```powershell
# Today's orphan / dangling repair events
Get-Content logs\audit-$(Get-Date -Format yyyy-MM-dd).log |
  Select-String 'FILE_ADOPTED|DANGLING_RECORD_REMOVED|ORPHAN_BATCH|DANGLING_BATCH' |
  Select-Object -Last 20

# Last 50 saves where title actually changed vs body-only
Get-Content logs\audit-$(Get-Date -Format yyyy-MM-dd).log |
  Select-String 'PAGE_UPDATED' |
  ForEach-Object { $_ -match 'titleChanged":true' } | Select-Object -Last 50

# Failed login attempts today (LDAP or local) — no USER_LOGIN event = no success
Get-Content logs\audit-$(Get-Date -Format yyyy-MM-dd).log | Select-String 'fail|error|ldap.*bind|auth'
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
| `NODE_ENV` | `development` | SHARED | string | `development` or `production`. In `production`: session cookies flip to `Secure` (over HTTPS/X-Forwarded-Proto), error pages drop stack traces, and static assets get 1d `Cache-Control: immutable`. |
| `LOG_LEVEL` | `info` | PER-NODE | enum | Winston log level: `error` (failures only) / `warn` (potential issues) / `info` (startup + mutations) / **`http` (every request URL + status)** / `debug` (CSRF tokens, session lookups, route resolution). Use `http` during TLS debug to see both plain and TLS listeners' request lines hit the audit stream. |
| `PORT` | `3000` | PER-NODE | int | Plaintext HTTP listen port. Always binds even when HTTPS is configured. In Docker keep container-internal port 3000 and publish via `-p 80:3000 -p 443:3443`. |
| **TLS / HTTPS (optional dual-stack, all PER-NODE)** | | | | |
| `HTTPS_PORT` | `3443` | PER-NODE | int | TLS listener port. **Ignored completely** unless *both* `SSL_CERT_PATH` and `SSL_KEY_PATH` are set AND the PEM files exist on disk. Use 443 on a bare-metal server; use 3443 when running as an unprivileged account (Windows non-admin, Linux without `CAP_NET_BIND_SERVICE`). |
| `SSL_CERT_PATH` | *(not set)* | PER-NODE | path | Absolute or **relative to `process.cwd()`** path to the PEM-encoded **full certificate chain** (Let's Encrypt `fullchain.pem`, a Windows exported `.cer` with chain, or the public part of a self-signed cert). Resolution happens in `server.js:_resolveTlsPath()`; relative paths are normalised via `path.resolve(process.cwd(), value)` early at boot. |
| `SSL_KEY_PATH` | *(not set)* | PER-NODE | path | Matching PEM-encoded **private key** (Let's Encrypt `privkey.pem`, a Windows-exported `.pvk` converted to PEM, or a self-signed key). Linux: **chmod 600** and own the file with the same UID that runs the wiki process. Windows: use NTFS ACLs so only Administrators + the service account can read it (the default ACL on `data\` already grants Admin-only write + user read; tighten via Properties → Security → Advanced if needed). |
| `SSL_CA_PATH` | *(not set)* | PER-NODE | path | Optional. Single concatenated PEM bundle of one-or-more additional **intermediate / root CAs** to attach to the Node TLS context. Automatically split on `-----BEGIN CERTIFICATE-----` boundaries and passed as `tls.createServer({ ca: [...] })` so multi-cert chains parse correctly regardless of blank-line separators in the bundle. Required only when a) you use a private internal CA whose root isn't in the default Mozilla store clients use, OR b) your leaf cert's issuer chain is longer than what fullchain.pem already contains. |
| `HTTPS_REDIRECT_HTTP` | `false` | PER-NODE | bool | `false` = **dev-friendly dual-stack**: both `http://<host>:<PORT>` and `https://<host>:<HTTPS_PORT>` serve the wiki independently, useful when one browser tab still has the plain HTTP bookmark and another is testing TLS. `true` = **production-like strict redirect**: plaintext **GET/HEAD** requests that carry a `Host` header are rewritten to **301 Moved Permanently → `https://<host-without-plain-port>:<HTTPS_PORT><path>`** + response emits `Strict-Transport-Security: max-age=31536000; includeSubDomains` so browsers pin to HTTPS for 1 year. **Body-carrying methods (POST/PUT/PATCH/DELETE) are NEVER redirected** — browsers drop the body across 30x; direct those requests at the canonical HTTPS URL or behind a TLS-terminating proxy that does the upgrade at layer 7. |
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
