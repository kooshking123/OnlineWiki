# OnlineWiki Changelog

All notable changes to this project will be documented in this file. The format is based on
[Keep a Changelog v1.1.0](https://keepachangelog.com/en/1.1.0/), and this project currently
tracks work as **Unreleased (HEAD)** — a proper version tag is cut from the first production
deployment milestone.

---

## [Unreleased] — HEAD of `main` as of 2026-09-18

> **Overall verification for this block:** scenario harnesses GREEN across the board.
> T9 uploads-folders scenario = **11 / 11 PASS**, duplicate-save regression = **14 / 14 PASS**,
> `node --check server.js` + `node --check public/js/editor.js` = **exit_code 0 / 0**.

### Added

- **🗂️ Uploads folder hierarchy (physical nested directories, up to 8 levels).**
  Documents area now supports real filesystem subfolders under `<DATA_DIR>/uploads/` — not
  virtual metadata. Server enforces nesting depth via `normalizeAndValidateFolderPath`.
  SyncThing replicates the directory tree exactly as it appears on disk (no folder-JSON to
  get out of sync). New routes:
  `POST /uploads/folders/new`, `POST /uploads/folders/rename/*`,
  `POST /uploads/folders/delete/*`, `POST /uploads/move` (batch move selected files with
  duplicate-collision cycle guard). `GET /uploads/folders/tree` returns a hierarchical tree
  for the picker sidebar.
- **🗂️ Folder-aware TinyMCE attachment picker (dual-mode `/api/uploads`).**
  Insert Image / Insert Link to File dialog exposes a two-pane layout: (left) sidebar folder
  tree with per-node file-count chips + empty-state indicators, (right) breadcrumb +
  folder-entry cards + file grid. `GET /api/uploads` supports two query modes:
  `?structured=1&path=<folder>` returns folder-scoped files + subfolder entries +
  `danglingRecords[]`; flat (default) returns recursive all-files array backwards-compatible
  with the legacy sidebar chips, with new optional `orphan: true|false` boolean per item.
  Wildcard serve route `/uploads/*` URI-encodes path segments individually so spaces,
  Unicode, `&`, `#` all resolve correctly.
- **🚨 Bidirectional orphan upload detection & repair (Type A + Type B).**
  Every SSR Documents render and every folder-scoped API call performs a 2-way set diff
  via the new `buildOrphanInventory(scopeFolderPath?)` helper:
  - **Type A — orphan files (disk but no index record):** shown with ⚠ amber badge.
    Repair buttons per-row: **Adopt** (writes a minimal uploads.json entry using
    `stat.birthtime`, byte size, current user as uploader) and **Delete** (permanent disk
    erase, audit-logged as `FILE_DELETED` with `orphan: true` metadata). Batch via toolbar
    **Adopt All** folder-scoped button.
  - **Type B — dangling records (index record but no disk file):** shown with 🗑️ red badge
    in a dedicated `#danglingRowsTbody` below the normal file rows. **NEVER shown in the
    picker** (triple-locked: server filtered from flat `/api/uploads`, client
    `renderPickerFilesFlat` + `renderPickerFolder` both filter, CSS
    `.attach-picker-item.is-dangling { display:none }` catch-all). Per-row:
    **Remove Record** deletes the index entry *and* scans every page JSON `attachments[]`
    array with O(1) Set lookups for both storedName and folderPath/storedName composite.
    Batch toolbar: **Prune Dangling** (folder-scoped) + **Global Prune Dangling** (danger
    variant, scans all folders in one POST).
  - Header count pills: `⚠ N untracked · 🗑️ M dangling`; dual-card warn/danger callout banner
    auto-renders when either count > 0, auto-hides + disables batch toolbar buttons when
    both counts reach zero.
  - Four new audit events: `FILE_ADOPTED`, `ORPHAN_BATCH_ADOPTED`,
    `DANGLING_RECORD_REMOVED`, `DANGLING_BATCH_PRUNED` (all behind `ensureRole('editor')`).
- **HTTP + HTTPS dual-stack listener (optional TLS on a second Express binding).**
  Three deployment modes: HTTP-only (default, good for TLS-terminating reverse proxies),
  dual HTTP+HTTPS (direct bare-metal production), HTTPS-only with safe redirect. HTTP
  redirects explicitly target **GET/HEAD only** and send `301 Moved Permanently` + a
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` pin header. Body-carrying
  methods (POST/PUT/PATCH/DELETE) are never redirected (browsers drop bodies across 30x).
  `SSL_CERT_PATH` / `SSL_KEY_PATH` / `SSL_CA_PATH` env vars — paths relative to
  `process.cwd()` are resolved with `path.resolve` at boot, `https` module is only
  `require()`d when TLS is actually configured (no overhead when plain-HTTP-only).
  Self-signed SAN certificate one-liner (Windows + Git-OpenSSL) documented in README.
  Graceful shutdown: `SIGINT` / `SIGTERM` close both listeners in parallel, wait for
  in-flight drain, then give winston file transport 400 ms to flush last audit lines.
- **🌗 Per-user light/dark theme switch + FOUC-free first paint.** Users self-select
  `light` or `dark` via topbar sun/moon toggle or My Profile → Preferences swatches.
  Persisted in `users.json[<username>].theme`; fast-path non-HttpOnly 30-day `theme` cookie
  is written on every change, so an inline `<script>` in `<head>` (before CSS loads) can
  set `html.theme-light` / `html.theme-dark` synchronously — eliminating theme flash.
  TinyMCE 7 chrome skin (`oxide` / `oxide-dark`) and `content_css` (`default` / `dark`)
  swap synchronously; pages that have TinyMCE open at theme-change time trigger a 60 ms
  delayed reload because TinyMCE cannot hot-swap skins at runtime. Login screen uses a
  separate hard-coded neutral brand theme (blue/purple gradient) so a user with `dark`
  selected does not "leak" their preference to a shared kiosk login page. Legacy users
  with no `theme` field default to `light` at read time (no migration script needed;
  lazily backfilled on first profile write).
- **🛡️ One-click save parity (duplicate-guard asymmetry bugfix).**
  The legacy duplicate-title guard fired server-side on *every* save even when the title
  hadn't actually changed, silently re-rendering the edit form and requiring a second
  click before the write actually landed. Server POST /pages/:slug/edit now mirrors the
  client predicate exactly using `titleActuallyChanged` === case-insensitive comparison
  against the persisted slug. Body-only edits skip the duplicate guard entirely → a single
  Save Page click always persists. `PAGE_UPDATED` audit events now carry both
  `titleChanged` and `contentChanged` booleans so log triage can distinguish between
  body-only saves and real title changes.
- **Audit Event Reference table + grep triage patterns (README § Audit).** 14 distinct
  audit types documented with fields and role requirements; PowerShell on-call snippets
  for orphan repair, save-triage, and failed-login searches.
- **`normalizeAndValidateFolderPath(folder)` + `assertWithinBaseDir(base, rel)` security
  primitives** centralised in `server.js`; every file/folder mutation (create / rename /
  delete / move / adopt / prune) routes through them, and attempts to escape
  `DATA_DIR/uploads`, exceed 8 nesting levels, or reference `..` segments return 400.

### Changed

- **Duplicate-title guard confirm dialog:** only shown when the user has *actually changed
  the title* (`titleActuallyChanged` on both sides). Body-only saves are direct, one-click,
  no confirm, no re-render, no modal.
- **Upload Documents UI expanded:** old flat list upgraded to folder breadcrumb + toolbar
  (New Folder, Move *selected-count*, Adopt All, Prune Dangling, Global Prune Dangling) +
  three rowgroups (folders, files, dangling records) with independent client-side live
  search scoping.
- **Role permissions clarified:** `reader` = view only, `editor` = create/edit/delete
  pages, upload & delete files, **create/rename/delete folders & move files between them**,
  **repair orphans (6 actions total)**; `administrator` = everything + user management +
  site branding/settings.
- **Page view/edit delete cascades:** when deleting a page, its referenced attachments
  (both root-level `storedName` and nested `folderPath/storedName`) are removed from
  `uploads.json` before the file is unlinked from disk — eliminating dangling-record
  production in the standard delete path.

### Fixed

- **"Double-click to save" bug.** (root cause: duplicate guard client/server predicate
  asymmetry.) Server `POST /pages/:slug/edit` duplicate check now gated by
  `titleActuallyChanged` parity with the client. Regression harness 14/14 PASS.
- **Temporal Dead Zone ReferenceError in `uploads.ejs` (L33):** original orphan callout
  block referenced `_isEditorOrBetter` above the `const _isEditorOrBetter` declaration.
  EJS executes `<% %>` blocks sequentially; `const/let` have a TDZ. Fix: relocated the
  `_userRole → _isEditorOrBetter → _pathQs → _hasOrphans → _hasDangling` declaration
  block to lines 29–35, **above** the orphan-callout open if/end.
- **Uploads listing previously showed folder-scoped files but had no structured folder
  API for the picker** — `GET /api/uploads` now has explicit dual-mode switch
  (`structured=1` vs default flat backward-compat array).
- **TinyMCE Insert Image previously only showed root-level files (flat list).** Folder
  sidebar + breadcrumb + folder cards now present; nested files have correctly-URL-encoded
  download URLs.
- **Uploads `Delete` button for orphan files was `disabled` by design with no repair
  affordance** — button now enabled + adjacent `Adopt Record` button added. All dangling
  records were previously completely invisible.

### Security

- `assertWithinBaseDir(DATA_DIR/uploads, path)` now wraps **all** orphan repair routes
  (adopt single, adopt-all, dangling remove, dangling prune) — wildcards cannot escape
  the uploads root.
- `normalizeAndValidateFolderPath` enforces: no `.` or `..` segments, no leading/trailing
  slashes, ≤ 8 levels deep, no null bytes. Every route that accepts a `path` body
  parameter (create folder, rename folder, move files, adopt-all scoped, prune scoped)
  routes through it before any filesystem I/O.
- Dangling records filtered server-side from `/api/uploads` flat endpoint before
  serialization — client-side picker never sees them (prevents user-facing 404 attach
  chips even if a future edit removes the client filter).
- Save-guard parity means a CSRF-style craft of `confirmDuplicate=true` on an unchanged
  title is still refused server-side because `titleActuallyChanged === false` skips the
  duplicate flow; saves without CSRF token fail CSRF middleware first.

### E2E / Verification Dates

- **TinyMCE folder picker SSR + sidebar rendering:** 2026-09-18. Verified via MCP
  integrated_browser (Engineering folder view + Specs deep descend works).
- **Orphan detection + count badges + callout rendering:** 2026-09-18. Root subtitle
  showed "2 folders, 6 files · ⚠ 2 untracked · 🗑️ 1 dangling"; Engineering folder
  "1 folder, 1 file · ⚠ 1 untracked · 🗑️ 1 dangling".
- **Orphan repair E2E (all 6 actions):** 2026-09-18, browser MCP click-validated:
  (1) Prune Dangling (folder), (2) Adopt single orphan → normal row transform,
  (3) Delete orphan (custom confirm modal flow), (4) Remove Record single dangling,
  (5) Adopt All (folder batch), (6) Global Prune Dangling (2 records across folders).
  All 6 flows returned HTTP 302 with `_t=` flash timestamp token; post-redirect row state
  + toolbar button enabled/disabled state matched expectations.
- **Light theme CSS (amber/red orphan + dangling colors):** 2026-09-18, screenshot
  `uploads-light-theme-orphan.png` — both amber untracked and red dangling pills render.
- **Scenario harness runs (final):** T9 uploads-folders scenario 11/11 PASS,
  duplicate-save regression 14/14 PASS.

---

## Before changelog tracking (pre-history)

- Base OnlineWiki build: LDAP auth, local user registry, bcrypt password hashes,
  role-based access control (reader / editor / administrator).
- Flat Documents uploads table (no folders, no orphan detection; only root-level files).
- Hierarchy reorder 4-button cluster (promote/demote/up/down) with cycle guards.
- Duplicate-title client confirm dialog + server `confirmDuplicate` gating (pre-parity
  bug — double-click save bug existed here).
- SyncThing directory replication `DATA_DIR` layout (TEMPLATE A / TEMPLATE B stignore
  variants shipped in repo-root `.stignore`).
- Session three-mode (single, syncthing-file, Redis) + rolling idle timeout layered
  model (8 h hard ceiling, 15 min human idle, 120 s pre-expiry countdown dialog with
  Extend session / Log out now buttons + ESC shortcut).
- `connect-flash@0.1.1` DEP0044 silent-noise monkey-patch (`util.isArray = Array.isArray`)
  applied before first middleware require.
