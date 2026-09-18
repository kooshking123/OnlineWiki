# OnlineWiki — Admin & Editor Quick Reference

*Cheat-sheet for daily operations. For full prose, scenarios, wire-format schemas, and
route-by-route behaviour, see the project [README.md](./README.md). For what changed, see
[CHANGELOG.md](./CHANGELOG.md).*

---

## 1. Role Matrix (3 roles × permissions)

| Permission / Capability | **Reader** | **Editor** | **Administrator** |
|---|---|---|---|
| View pages, attachments, search, download files | ✅ yes | ✅ yes | ✅ yes |
| Switch light / dark theme, update own profile / avatar, change own password | ✅ yes | ✅ yes | ✅ yes |
| Create new pages, edit, rename, delete pages; promote/demote/up/down reorder | ❌ no | ✅ yes | ✅ yes |
| Upload files; delete uploaded files | ❌ no | ✅ yes | ✅ yes |
| **Uploads folder operations**: create / rename / delete empty folders, **move files between folders** (Move selected toolbar) | ❌ no (Readers see all upload folders & files read-only, all buttons visible-but-disabled with tooltip) | ✅ yes | ✅ yes |
| **Bidirectional orphan upload repair** (6 actions: Adopt, Delete orphan, Adopt All, Remove Record, Prune Dangling, Global Prune Dangling) | ❌ no | ✅ yes (all 6 actions write audit events; server `ensureRole('editor')` cannot be bypassed by crafting a POST by hand) | ✅ yes |
| Manage users (invite, disable, reset password, change role to reader/editor/admin), site branding + logo, site title / tagline, configure LDAP, set registration policy | ❌ no | ❌ no | ✅ yes |
| Hand-crafted POST guard (enforced server side regardless of client disabled state) | — every write endpoint has `ensureRole('editor')` or `ensureRole('administrator')` middleware — |

> **Role enforcement**: Reader buttons are never hidden from the DOM (project UX convention
> of *visible-disabled with tooltip*, not conditionally-rendered). This means a Reader who
> removes the `disabled` attribute in devtools still gets **HTTP 403 Forbidden** server-side;
> nothing writes.

---

## 2. Documents Page — common operations (editors + admins)

### Upload basics

| Step | What to do | Where it writes |
|---|---|---|
| 1 | Open **Documents** in the sidebar. You land in the **upload root** (breadcrumb shows "Uploads Home"). If you want files inside a subfolder, navigate into the target folder FIRST using the folder table entries (📁 rows) or the breadcrumb. The current-viewed folder is the upload destination. | Nothing yet. |
| 2 | Drop files onto the dropzone, or click **Choose File**. Support: PDF, Word, Excel, PPTX, images (PNG/JPG/WEBP/GIF/SVG), ZIP, CSV. Hard cap 50 MB per file (`UPLOAD_MAX_BYTES` in `.env`). | File bytes → `<DATA_DIR>/uploads/<folderPath>/`. Index row → `<DATA_DIR>/uploads.json`. Audit event → `FILE_UPLOADED`. |
| 3 | (TinyMCE integration) Open any page editor → **Quick Media Insert** sidebar → Insert Image or Insert Link to File. Dialog has folder tree left, folder cards + file grid right; picker mirrors the Documents breadcrumb + nested view, search works across current folder + children. Download URLs written into `<img src>` / `<a href>` are URI-encoded per path segment so spaces/Unicode/`&`/`#` resolve correctly. | Only writes into page JSON `attachments[]` array on save. |

### Folder operations (toolbar + per-row)

| Operation | UI path | Server route | Audit event |
|---|---|---|---|
| Create folder | Click blue **New Folder** (top toolbar) → prompt for name → OK. Valid name = 1–100 chars, matches `SAFE_NAME_RE = ^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$`. Collision with existing folder = 409 flash. | `POST /uploads/folders/create` | `FOLDER_CREATED` |
| Rename folder | Per-row pencil (📁 row) → prompt. Root (empty path) has no rename button. Name collision within parent = 409 abort; dir on disk unchanged. | `POST /uploads/folders/rename` | `FOLDER_RENAMED` |
| Delete folder | Per-row trash (📁 row) → confirm dialog "Permanently delete folder 'X'? It must be empty of files and subfolders first." Server does `readdir.length > 0 → EXACT flash "Folder is not empty — move or delete contents first."` aborts. | `POST /uploads/folders/delete` | `FOLDER_DELETED` |
| **Move selected files (batch)** | Check ≥ 1 file-row checkbox → toolbar **Move N** blue button enables → folder picker modal → select destination → confirm. Partial success NEVER occurs: if any file collides basename-wise in target, OR any file fails containment/cycle guard, **no files move** (rollback reverses any already-renamed entries best-effort, uploads.json reverted). Cycle guard: cannot move file into folder that already holds exactly that basename. | `POST /uploads/files/move` (body `destinationPath=<rel path>`, `files=a&files=b&files=c` repeated keys NOT `files[]`) | One `FILE_MOVED` audit per file moved. |

### Max nesting

```
MAX_FOLDER_DEPTH = 8 segments.
```

Server-wide constant. Create / rename / upload target / move destination / listing path all
route through `normalizeAndValidateFolderPath()` which rejects depths above 8 with flash
`"Max folder depth 8 exceeded."` — single edit-point if the team wants to raise it later.

---

## 3. 6 Orphan Repair Actions (Decision Matrix — editors + admins)

### Understanding the two upload integrity failure types

| Failure type | Synonyms shown in UI | Root cause | Counted in header badge | Pickers show it? |
|---|---|---|---|---|
| **Type A — Orphan** | `⚠ Untracked` (amber pill #f59e0b) | File exists on disk (`<DATA_DIR>/uploads/...`) but `<DATA_DIR>/uploads.json` has no record. Common causes: file added via SyncThing/rsync/Explorer outside the UI, record lost on replica split-brain recovery. | `⚠ N untracked` | No — move toolbar skips orphan checkboxes disabled; picker never sees it. |
| **Type B — Dangling** | `🗑 Dangling` (red pill #dc2626) | `uploads.json` has a record for storedName X, but `<DATA_DIR>/uploads/<folderPath>/X` does NOT exist on disk. Common causes: user deleted file outside UI (rm/Explorer), SyncThing conflict resolved to "deleted", disk full truncated upload, file was attachment on a page but page delete cascade somehow missed it (shouldn't happen; normal page delete DOES cascade — if you see this, report it). | `🗑 M dangling` | **Never** — triple-locked: (1) flat `/api/uploads` never emits recordMissing rows; (2) `editor.js` flat + folder render both JS-filter; (3) CSS `.attach-picker-item.is-dangling {display:none}` catch-all. |

### The 6 repair actions (header pills + toolbar go to zero when clean)

| # | Action | Target type | Scope | Button lives on | Confirm prompt | Server route | Audit event | Side effects |
|---|---|---|---|---|---|---|---|---|
| 1 | **Adopt** | Type A (orphan) | Single file | Per-row: ⚠ orange row, new blue "Adopt Record" button | None (direct submit; Delete still has prompt) | `POST /uploads/adopt/*` (wildcard) + hidden body `storedName=<name>` | `FILE_ADOPTED` | Creates index record using real `stat.birthtime`, byte size, current user as uploader; post-submit the row visually transforms from ⚠ → normal (checkbox enables, ⚠ icon + Adopt button disappear, badges decrement). |
| 2 | **Delete** (orphan file variant) | Type A (orphan) | Single file | Per-row: same red Delete button as normal files (⚠ no longer `disabled` — old code disabled it because record couldn't be found; now enabled). | Custom confirm: *"Permanently delete 'untracked-foo.txt'? It has NO upload record and will be removed from disk. This cannot be undone."* | `POST /uploads/delete/*` wildcard (existing endpoint; server correctly handles case idx = -1 orphan with correct audit metadata) | `FILE_DELETED` with extra JSON `{ orphan: true }` | File unlinked from disk permanently; file count + orphan badge decrement. |
| 3 | **Adopt All** | Type A (orphan) | **Current folder only** (scoped) | Documents top toolbar, amber secondary grey+orange button. Visible-disabled when folder orphan count = 0. | `window.confirm("Adopt ALL untracked orphan files in the current folder? This will create " + orphanFileCount + " new upload records using the current user as the uploader.")` | `POST /uploads/adopt-all` body `{ path: <currentFolderPath> }` | `ORPHAN_BATCH_ADOPTED { folderPath, adoptedCount }` (plus N descendant `FILE_ADOPTED` one per file) | Every orphan in current folder transforms visually. Zero orphans in this folder afterwards (global orphans in OTHER folders untouched). Badge decrements locally. |
| 4 | **Remove Record** | Type B (dangling) | Single record | Per-row: dangling records appear in DEDICATED `#danglingRowsTbody` tbody BELOW normal files, red rows, primary action green "Remove Record" instead of Delete. | Custom confirm: *"Remove the dangling upload record for 'foo.pdf'? The file is already missing from disk. Any page attachments that reference this path will also be cleaned."* | `POST /uploads/dangling/remove` body `{ relPath: "<folderPath>/<storedName>" }` (slash composite) | `DANGLING_RECORD_REMOVED { storedName, folderPath, pagesReferencedCleaned }` | Index entry deleted; server runs `listPages()` and for every page JSON scans `attachments[]` using `new Set([storedName, composite])` O(1) lookup → removes matching entries → writes page atomically. |
| 5 | **Prune Dangling** | Type B (dangling) | **Current folder only** (scoped) | Documents top toolbar, red danger secondary button. Visible-disabled when folder dangling count = 0. | `window.confirm("Prune ALL dangling records in current folder? This will delete " + danglingRecordCount + " stale upload records and clean page attachments that reference them. This cannot be undone.")` | `POST /uploads/dangling/prune` body `{ path: <currentFolderPath> }` | `DANGLING_BATCH_PRUNED { scope:"folder", folderPath, removedCount, attachmentsCleaned }` (plus N descendant single events) | Same attachment cascade per record as action (4). After run: dangling tbody in current folder is empty. Other folders' dangling records untouched. |
| 6 | **Global Prune Dangling** | Type B (dangling) | **Entire uploads tree (ALL folders)**. Danger variant. | Documents top toolbar, FULLY RED danger variant button (not just pill). *Always rendered regardless of current folder* — acts across the tree. | Two-stage: first `window.confirm(…scans every folder in the entire uploads tree. Are you sure?")`; then if (still OK) a SECOND `window.confirm(…will run attachment cleanup against every page in the wiki. This is irreversible — confirm twice.)`. Only if BOTH confirms OK → submit. | `POST /uploads/dangling/prune` body `{ path: "__global__" }` (sentinel string; server switches to scope="global") | `DANGLING_BATCH_PRUNED { scope:"global", removedCount, attachmentsCleaned }` + N descendant singles | After run: badges for dangling → 0 across every folder in Documents; dangling tbodies empty; orphan badges may still be non-zero (orphans are separate problem space). If both badges then hit 0, callout banner DOM-removed + all batch buttons disabled. |

### Clean state = zero orphans AND zero dangling = automatic UI response

```ejs
<% if (_hasOrphans || _hasDangling) { %>
  …callout banner + toolbar buttons rendered normally…
<% } /* else: banner is COMPLETELY removed from HTML (not CSS hidden). */ %>
```

Batch toolbar buttons (Adopt All, Prune Dangling) have `disabled` attribute server-set
when their respective scope count = 0. Global Prune Dangling: never disabled (it operates
across all folders, even if the current folder has none), still shows "danger red" styling
even on clean folders.

---

## 4. Save page — 1-click flow vs duplicate collision flow

### One-click save (the common case, 99 % of edits)

| Check | What happens |
|---|---|
| Did the title actually change since the page loaded? | Server mirrors the client predicate **exactly**: `titleActuallyChanged = page.title !== incoming.title (case-insensitive)`. If FALSE (you only edited body, updatedAt, tags, etc.) → duplicate guard is SKIPPED ENTIRELY. Save direct. ONE click. Zero confirms. No re-render. Cured the old "must double-click Save Page" bug (old server fired guard on every save regardless of title change). |
| Any page edit — no title change. | `Save Page` → one POST → writes page atomically → 302 to viewer. Audit `PAGE_UPDATED { titleChanged:false, contentChanged:true, hierarchyChanged:false }`. (All three booleans are logged so logs can distinguish body-only vs title vs tree reorder.) |

### Duplicate collision dialog (only when title actually DOES change to collide with another page DIFFERENT slug)

| Check | What happens |
|---|---|
| Client layer 1 — synchronous gating (editor.js): | Save button uses `type="button"` (NOT `type=submit`). Click does: `e.preventDefault()`; `tinymce.triggerSave()`; check if title actually changed → if yes, fetch duplicates or use inline list → `window.confirm("Another page already has this title … overwrite?")` — 100 % blocking, synchronous, nothing proceeds until user OK/Cancel. Plus **60 ms TinyMCE skin reload guard** if theme just flipped (editor can't hot-swap oxide ↔ oxide-dark, prevents double submit false positive). If user hits **Cancel**: submit never fires, nothing writes. If user hits **OK**: form submit (raw submit, not requestSubmit, no submit event fires, no racing listeners) with `confirmDuplicate=true` embedded. |
| Server layer 2 — enforcement (mirrors client parity exactly): | If `titleActuallyChanged === false` → skip (same as client). If TRUE + collides with other slug: if `confirmDuplicate === "true"` → save proceeds, audit includes `{ confirmDuplicate: true }`; else → **refuse save, re-render edit form INLINE** (not 302 redirect so user's TinyMCE draft + all form fields are preserved — zero data loss) + flash error. Tamper guard: layer 2 is the SOLE arbiter regardless of client JS patches. |

---

## 5. Session idle gates — troubleshooting forced sign-outs

| Event | Idle window | What happens | What to do as editor/admin |
|---|---|---|---|
| **Human idle** (no key/mouse/touch) | 15 minutes | Countdown modal 120 s; "Extend session" / "Log out now" buttons; ESC short-cut = Extend | Click Extend or press ESC within 120 s to renew |
| **Rolling idle refresh boundary** | Every ~20 min rolling | Session writes to disk (sessions-file mode) or Redis `EXPIRE` refresh | No action needed if you have any activity |
| **Hard cap** (absolute ceiling even for constant activity) | 8 hours after login | Forced sign-out. Audit `SESSIONS_EXPIRED` (batch job) or `USER_LOGOUT { reason: "inactive" }` if per-user. | Re-login. This prevents sessions that survive multi-day shared kiosk forgetfulness. |

---

## 6. Troubleshooting — 3 Audit Log Queries (PowerShell)

All mutation ops write JSON NDJSON lines to `<LOG_DIR>/audit-YYYY-MM-DD.log`. Format:

```json
{"at":"2026-09-18T02:00:00.000Z","event":"FILE_ADOPTED","by":"admin","ip":"127.0.0.1","storedName":"orphan-foo.pdf","folderPath":"Engineering"}
```

### 6-1. Who repaired what upload integrity issues today?

```powershell
$today = Get-Date -Format yyyy-MM-dd
Get-Content "logs\audit-$today.log" |
  Select-String 'FILE_ADOPTED|ORPHAN_BATCH_ADOPTED|DANGLING_RECORD_REMOVED|DANGLING_BATCH_PRUNED' |
  Select-Object -Last 20 |
  ForEach-Object { $_ }
```

Expected audit events you will see for the 6 repair actions: `FILE_ADOPTED` (1),
`FILE_DELETED { orphan:true }` (2), `ORPHAN_BATCH_ADOPTED` (3), `DANGLING_RECORD_REMOVED`
(4), `DANGLING_BATCH_PRUNED` — once with `scope=folder` (5), once with `scope=global` (6).

### 6-2. Duplicate-title collisions vs body-only saves (1-click regression check)

```powershell
# Show last 50 saves. Distinguish body-only (titleChanged:false) from real title edits.
Get-Content "logs\audit-$today.log" |
  Select-String 'PAGE_UPDATED' |
  Select-Object -Last 50
```

If users report "must double-click to save" was re-introduced after a deploy, check logs
for: (a) server still emits `titleActuallyChanged` → false → saves should ALWAYS direct
(no confirm); if any of them have a duplicate check firing when `titleChanged:false`,
the parity predicate has regressed → patch server before user outreach.

### 6-3. Folder mutations & file moves (verify uploads structure drift)

```powershell
Get-Content "logs\audit-$today.log" |
  Select-String 'FOLDER_CREATED|FOLDER_RENAMED|FOLDER_DELETED|FILES_MOVED|FILE_UPLOADED' |
  ForEach-Object {
    $j = $_ | ConvertFrom-Json
    [PSCustomObject]@{ at=$j.at; who=$j.by; evt=$j.event; detail=$j | ConvertTo-Json -Compress -Depth 3 }
  } | Format-Table -AutoSize
```

---

## 7. Quick environmental assumptions

| Variable | Where documented | Current state of feature additions |
|---|---|---|
| New env vars for uploads / orphan / picker features? | [README.md § Environment Variable Reference](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/README.md#L906-L957) | **NONE introduced.** All folder/orphan behaviour uses existing `DATA_DIR` + `LOG_DIR` roots, physical directories discovered at runtime, and `uploads.json` index file. Nothing new to configure in `.env` for this cycle. |
| Folder depth cap? | USAGE.md §2 end | `MAX_FOLDER_DEPTH = 8` server constant. |
| npm installs for this cycle? | CHANGELOG.md § `[Unreleased] Added` | **ZERO.** Entirely vanilla Express + EJS + existing server helpers + CSS. |
| SyncThing compatibility? | uploads spec §8.1, §8.2 | Folders are REAL directories (not JSON sidecar metadata) → replicates 1:1. `uploads.json` replicated same way as `pages/*.json`. |

*— End of reference card. See README.md for full prose / scenarios / wire format schemas / audit event table with all 14 event types.*
