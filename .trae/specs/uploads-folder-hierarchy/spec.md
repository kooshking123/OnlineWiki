# Uploads Folder Hierarchy — Feature Specification

- **Feature**: Nested folder / subfolder organisation for uploaded documents (replacing today's flat list).
- **Owner**: Engineering
- **Status**: **IMPLEMENTED & VERIFIED (spec approved 2026-09-17; shipped 2026-09-17; all 16 ACs pass; 11/11 scenario PASS; 14/14 duplicate-save regression PASS)**
- **Created**: 2026-09-17
- **Related files**: [server.js](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js), [views/uploads.ejs](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/views/uploads.ejs), [public/js/app.js](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/public/js/app.js), [public/css/style.css](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/public/css/style.css), [lib/logger.js](file:///C:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/lib/logger.js).

---

## 1. Problem

Today every uploaded document sits at the top level of the **Uploads** page in a single flat list, regardless of project, author, or topic. As document count grows:

1. Users scan 50+ rows in alphabetical order just to find the "2026 budget" PDF mixed in with meeting minutes, HR docs, screenshots, and page attachments.
2. There is no way to **group related files together** (e.g. "Product / Roadmaps", "Legal / NDAs", "Engineering / Specs / v1.2") except by adopting artificial filename prefixes like `ENG-SPEC-123-foo.pdf`.
3. Bulk operations on a logical set are impossible: moving 12 files into a "2026 Q3 Archive" area means renaming them 12 times in the filesystem outside the UI.
4. New collaborators have no onboarding hint about document structure — there is no "correct place to upload X".

The result is **discoverability failure** for a wiki that is specifically intended as an organisational knowledge base.

## 2. Users & Goals

### Primary users

| User role | Representative goal |
|---|---|
| **Editor** | Organise my uploads into project folders so my team can find things. Batch-move 10 files I just uploaded into "Engineering / Sprint-39". |
| **Admin** | Enforce a reasonable top-level folder structure (Policy, HR, Finance, Projects, …) and fix misfiled docs. |
| **Reader** | Navigate the folder tree to find the document I need; I never create/rename/move anything. |

### Goals

- **G1 — Navigate**: Any authenticated user (incl. Readers) can traverse a tree of folders on the Uploads page, entering any folder via breadcrumb or click, and see only the immediate children of that folder.
- **G2 — Organise**: Editors & Admins can create folders, rename folders, delete **empty** folders, and move files between folders using checkbox+toolbar.
- **G3 — Store physically**: The folder tree mirrors real nested subdirectories on disk under `DATA_DIR/uploads/`, so URLs like `/uploads/Engineering/Specs/req.pdf` resolve naturally, SyncThing replicates the tree across nodes exactly, and disaster recovery from a bare backup needs no JSON index.
- **G4 — Compatible**: Existing flat uploads (already uploaded before this feature) remain at the **root** `/uploads/` level, still listable, still downloadable, with their original filenames preserved — no migration script required.
- **G5 — Secure**: All the security invariants of today's upload system are preserved: authentication gate, role ACLs, path-traversal containment, MIME sniffing, max-file-size enforcement, audit logging on write operations (create/move/rename/delete).

## 3. Non-Goals (out of scope for v1)

- **NG-1** — Drag-and-drop row reordering inside a folder; we implement checkbox + toolbar Move only per user's explicit choice. (Drag-and-drop of **files into folders at upload time** via the existing drop-zone is implicitly supported: upload always targets the **currently viewed folder**.)
- **NG-2** — Per-folder ACLs, ownership, visibility flags, or folder-level readers. Folder permission inherits from global role (Editor/Admin vs Reader). (User picked "Other" with no custom text — this is the recommended default; see Open Questions §9.1.)
- **NG-3** — Virtual/JSON-index folders. Files are stored physically on disk in nested dirs. (User picked "Other" with no custom text — this is the recommended default; see §9.2.)
- **NG-4** — Folder-level tags, colour coding, starred/bookmarked folders, folder descriptions, or per-folder custom sorting.
- **NG-5** — Shared public (unauthenticated) deep-links to files or folders inside nested dirs. Today's `/uploads/<path>` route is auth-gated; that stays.
- **NG-6** — Recursive delete of non-empty folders (user explicitly chose **Reject non-empty delete**; must empty folder manually).
- **NG-7** — Move of folders (only files move in v1). Moving a folder and all its children introduces too many edge cases around in-flight moves across nodes in SyncThing; keep it for a future v2.

## 4. Functional Requirements (FR)

### FR-1 — Folder listing & tree navigation

- **FR-1.1** Uploads page accepts an optional `?path=<url-encoded subpath>` query parameter. Default = root (empty path).
- **FR-1.2** Uploads page renders: (a) a breadcrumb strip with clickable crumbs (Home → … → Current), each crumb links back to its ancestor with `?path=…`; (b) a listing table with **two sections first the subfolders, then the files**, each sortable alphabetically by name (folders always before files in the UI, regardless of sort direction).
- **FR-1.3** Readers + Editors + Admins can navigate every folder (view-only for Readers).
- **FR-1.4** Invalid paths (e.g. `/uploads?path=..%2F..%2Fetc` or `/uploads?path=DoesNotExist`) return HTTP 400 with a flash error and redirect to root — never silently fall through, never expose content outside `DATA_DIR/uploads/`.

### FR-2 — Create folder

- **FR-2.1** Uploads page has a blue **New Folder** button (top right toolbar, visible only to Editor/Admin; button is always rendered and **disabled/greyed** for Readers per project UI convention of visible-disabled, not conditionally hidden).
- **FR-2.2** Clicking opens a prompt asking for a folder name. Client strips leading/trailing whitespace; rejects empty or all-whitespace.
- **FR-2.3** Server validates: (a) name is 1–100 chars; (b) name passes the SAME `SAFE_NAME_RE` rule used for filenames today (no path separators, no `..`, no control chars); (c) parent folder exists; (d) folder name is **unique within its parent** (case-insensitive on Windows / macOS, case-sensitive-equivalence checked regardless of host FS).
- **FR-2.4** On success: `mkdirp` the physical directory inside `DATA_DIR/uploads/<subpath>/<name>`, emit `FOLDER_CREATED` audit event with `{ actor, path, folderName, normalizedPath }`, flash success, redirect back to the current folder's listing.
- **FR-2.5** On failure (duplicate, invalid name, traversal, disk error): return 400 / 409 with flash error, **do NOT create directory**, no audit event on user-error.

### FR-3 — Rename folder

- **FR-3.1** Each folder row in the listing has a secondary **Rename** action (inline pencil icon button). Visible+enabled for Editor/Admin, **visible-but-disabled** for Readers.
- **FR-3.2** Same client/server name validation rules as FR-2.3 (1–100 chars, SAFE_NAME_RE, uniqueness within parent, no `..`).
- **FR-3.3** Server physically renames the directory via `fs.promises.rename(...)` inside `DATA_DIR/uploads/` (single atomic dir rename on POSIX/NTFS). No file-level byte copies. Deep links `/uploads/<old>/foo.pdf` become 404 after rename; this is a documented caveat.
- **FR-3.4** Audit event `FOLDER_RENAMED` `{ actor, oldPath, newPath }`. UpdatedAt on any row records stored in uploads.json that reference a file under that path are mutated. Flash success and reload current ancestor page (after rename the renamed folder still lives in the same parent, so the same breadcrumb renders).
- **FR-3.5** Root (empty path) cannot be renamed. UI shows no rename action on root.

### FR-4 — Delete folder

- **FR-4.1** Each folder row has a **Delete** trash icon button (visible, same disabled-state rules). Confirm dialog: *"Permanently delete folder 'Contracts'? It must be empty of files and subfolders first."*
- **FR-4.2** Server inspects target with `fs.readdir`; if the directory is **not empty → reject with HTTP 400 and a clear error "Folder is not empty — move or delete contents first"** (explicit user choice; see FR-NG-6 / §2 questionnaire).
- **FR-4.3** If empty: `fs.rmdir` on the directory, audit `FOLDER_DELETED { actor, path }`, flash success, redirect to parent folder listing.
- **FR-4.4** Root cannot be deleted.

### FR-5 — Upload into current folder

- **FR-5.1** The existing upload drop-zone + browse button **target the currently viewed folder** (per `?path=`).
- **FR-5.2** Server `POST /uploads/upload` accepts a hidden form field `folderPath` (default = root). Server applies the SAME containment validation used by avatars/logos today: resolve relative to base `DATA_DIR/uploads/`, confirm result is inside base, block anything that escapes via `..` or symlinks.
- **FR-5.3** If the target folder does not exist → create it atomically with `mkdirp` (so future URLs work even if user typed folderPath manually in a bookmarked upload form).
- **FR-5.4** Existing max-file-size (default 32 MB per `.env.example UPLOAD_MAX_BYTES`), MIME-whitelist (`ALLOWED_UPLOAD_MIMES`), `sanitizeFilename()` rules, and `FILE_UPLOADED` audit event are **unchanged and still applied to nested uploads**.
- **FR-5.5** Uploads.json record for the file stores the **relative path including folder prefix** (e.g. `Engineering/Specs/req.pdf`) not just the basename, so the listing page can reconstruct the full URL.

### FR-6 — Download nested files

- **FR-6.1** The existing `GET /uploads/:filename` route becomes `GET /uploads/*` (wildcard) that serves `/uploads/<full path including slashes>`.
- **FR-6.2** Same containment enforcement as FR-5.2 (`path.join(UPLOAD_DIR, subpath)` → `assertWithinBaseDir(baseDir, finalPath)`, and NO symlink follow beyond containment checks.)
- **FR-6.3** Auth rules unchanged — any authenticated user can download any file.
- **FR-6.4** URLs from before the feature (e.g. `/uploads/contract.pdf` at root) continue resolving exactly as they do today — no migration needed.
- **FR-6.5** TinyMCE `<img src="/uploads/foo.png">` in-page embeds keep working (root path unchanged). `<img src="/uploads/2026/charts/Q3-revenue.png">` (new nested uploads) also resolve.

### FR-7 — Move files between folders (checkbox + toolbar)

- **FR-7.1** Each file row has a leading checkbox (visible for Editor/Admin). A toolbar "Move" blue action button is **visible but disabled** until ≥1 checkbox is selected (per project UI convention of disabled-not-hidden).
- **FR-7.2** Clicking Move when items are checked opens a folder-picker modal dialog showing the full folder tree (expandable/collapsible nested list; **folders only** — not files). Includes "Uploads Home (Root)" as the top-most option.
- **FR-7.3** Picker shows "You cannot move into the source folder itself or any of its descendants" — server-side validation double-checks this.
- **FR-7.4** Server validates every selected file: (a) files exist; (b) caller is Editor/Admin; (c) destination folder exists; (d) destination folder does NOT already contain a file with the same name (return 409 "A file named 'foo.pdf' already exists in target folder 'Contracts'. Rename one of them first."); (e) no `..` escape in source or target.
- **FR-7.5** On success: `fs.rename(...)` (atomic) each file from its source physical path to `<targetDir>/<basename>`, update records in `uploads.json` for each row, emit one `FILE_MOVED` audit event **per file** with `{ actor, from, to, targetFolder }`. Reload current folder listing.
- **FR-7.6** Partial success is NOT acceptable — if any one file fails validation for any reason (e.g. one name collision, one bad ACL), **no files are moved at all**. Whole request is a transaction via the following pattern: (1) validate all 1..N items in RAM (2) iff 100% passes → perform renames in a loop, (3) if a rename mid-loop throws (disk full, permissions, SyncThing in-flight rename) → rollback the already-moved renames (best-effort reverse `fs.rename` back).

### FR-8 — Backwards compatibility with legacy flat-file uploads.json

- **FR-8.1** `uploads.json` records are **additive** — every record gets a new `folderPath: "" | "path/to/folder"` string field (empty string = root). Records created before this feature will NOT have the field. Server MUST coerce missing `folderPath` → empty string at read time, so legacy listings remain at root.
- **FR-8.2** No migration script. Read-time coercion only. On next write of any legacy row (move, rename, delete), the row is re-saved with the new `folderPath` field populated.

## 5. Non-Functional Requirements (NFR)

- **NFR-1 (Security / containment rule)** No endpoint (list, download, upload, create-folder, rename, delete, move) ever resolves a path outside `DATA_DIR/uploads/`. Concretely: a file named `.env` inside a nested uploads subfolder returns 404 at `/uploads/foo/../../.env`, even with URL-encoded `..`. This is enforced identically to avatars/logos via the shared `assertWithinBaseDir()` helper.
- **NFR-2 (Latency)** Navigating into a folder with ≤500 children (subfolders + files combined) renders in ≤500 ms p50 on a cold laptop HDD (no database index; plain `fs.readdir` + uploads.json lookup).
- **NFR-3 (SyncThing-compatible)** Folder create/rename/delete operations write to plain filesystem directories inside the single replicated `DATA_DIR/uploads/` root, so SyncThing replicates the tree across nodes exactly the way it already replicates flat files. No JSON sidecar is required to restore structure from a backup.
- **NFR-4 (Regression — existing upload flow)** Uploading a file at the root (no folderPath set), downloading it, deleting it, and seeing it listed on the Uploads page — all 4 of these operations work identically to pre-feature on day-0 of the deploy, with zero migration, for files uploaded before the feature shipped.
- **NFR-5 (Audit completeness)** Every write operation (create folder, rename folder, delete folder, move file) emits a single structured winston audit event with actor username, paths before/after, and client IP.
- **NFR-6 (UI accessibility)** Folder tree listing, breadcrumb, checkbox+toolbar move, and modal folder picker are keyboard-accessible: Tab / Shift-Tab navigation, Enter to activate action, Space to toggle checkboxes, Esc to close any modal. Focus states are visible against both the light and dark themes (per theme spec §8, the uploads page must still re-render correctly under `html.theme-light` and `html.theme-dark`).
- **NFR-7 (Logging / debugging)** Any server-side 400/403/409/500 in the new folder routes logs a full JSON `system:error` line with `{ path, query, body minus file contents, normalizedPath, user }` before returning the flash response.

## 6. Constraints & Dependencies

### Hard constraints (binding)

- **C-1** No new runtime npm dependencies. Use only `fs.promises`, `path`, existing `assertWithinBaseDir`, `sanitizeFilename`, `SAFE_NAME_RE`, `mkdirpIfMissing`, `atomicWriteJson` already present in `server.js`. Implement client folder-tree in vanilla JS (no nested-list library).
- **C-2** `updatedAt` of uploads.json MUST be written on every folder or file write operation.
- **C-3** Cycle guard against moving a file into one of its own descendant folders (FR-7.3 server check).
- **C-4** Save buttons in all affected forms (folder create prompt, modal picker confirm) are `type="button"` followed by synchronous `form.submit()` (not `type=submit`, not `setTimeout(0)`) — per project convention from duplicate-save guard, avoids any race with confirm dialogs.
- **C-5** Any JSON literals injected into `<script>` blocks in `views/uploads.ejs` MUST use EJS `<%- JSON.stringify(...) %>` raw (not escaped `<%=`), per SyntaxError fix of theme-switch T3.
- **C-6** Read-only users: buttons are visible-but-disabled, with factual single-sentence tooltips (positioned above cursor, per project tooltip convention). Blue action buttons (New Folder, Move, Delete Selected) have NO tooltips per project convention.

### Assumptions

- **A-1 (Storage model = physical directories)** Folders are real subdirectories on disk under `DATA_DIR/uploads/`. User answered "Other" with no custom text on the storage-model question; this is the recommended default. See Open Questions §9.2.
- **A-2 (Folder ACL = inherit global role)** No folder-level owner or visibility flag. Folder permissions inherit directly from global role: Reader=view, Editor=write, Admin=write. User answered "Other" with no custom text; this is the recommended default. See §9.1.
- **A-3 (Move files only, not folders)** v1 does not implement folder move. See NG-7.

## 7. Acceptance Criteria (merged AC)

All ACs typed as either `rule` (objectively verifiable binary) or `rubric` (evaluative with scale+threshold).

| # | Type | Requirement (must pass) |
|---|---|---|
| **AC-1** | `rule` | FR-1 Navigation — Loading `/uploads` shows today's 2 pre-existing legacy test uploads (`kooshking123.png`, `admin.png`) at the root, with no folder query param, no migration script run, and their original download URLs `/uploads/kooshking123.png` still resolve 200 OK. |
| **AC-2** | `rule` | FR-1 Breadcrumb — Navigating to `/uploads?path=Engineering%2FSpecs` renders breadcrumb `Uploads Home › Engineering › Specs`; clicking "Engineering" returns to `?path=Engineering`; clicking "Uploads Home" returns to `/uploads` root (no query). |
| **AC-3** | `rule` | FR-1 Path-traversal block — `/uploads?path=..%2F..%2Fetc` and `/uploads?path=.%2F..%2Fdata%2Fusers.json` both return HTTP 400 with flash error and redirect to `/uploads` root, even though `data/users.json` physically exists. |
| **AC-4** | `rule` | FR-2 Create folder — As Editor user X, create folder "Project Alpha" at root, then enter it, create "v1.0" inside; both dirs appear in `data/uploads/Project Alpha/` and `data/uploads/Project Alpha/v1.0/` on disk; two `FOLDER_CREATED` audit events are present in the JSON audit log. |
| **AC-5** | `rule` | FR-2 Duplicate/empty validation — Attempting to create a second "Project Alpha" at root returns 409 with flash "A folder with that name already exists here"; attempting to create a folder named `../etc` or empty string returns 400 with validation error, no directory on disk, no audit event. |
| **AC-6** | `rule` | FR-3 Rename folder — Rename "Project Alpha" → "Project Beta". Directory on disk `data/uploads/Project Alpha/v1.0/` is now `data/uploads/Project Beta/v1.0/` (single atomic fs.rename). audit log has `FOLDER_RENAMED { oldPath: "Project Alpha", newPath: "Project Beta" }`. `FOLDER_CREATED` audit events for the two dirs still exist (they were NOT mutated retroactively). Re-accessing old deep URL `/uploads?path=Project+Alpha%2Fv1.0` returns 400/redirect, as expected after rename. |
| **AC-7** | `rule` | FR-4 Non-empty delete rejection — Create folder "Staging", upload one file into it, attempt to delete "Staging". Returns 400 "Folder is not empty — move or delete contents first". Dir on disk remains. Then delete the file, retry delete folder → success, dir removed, `FOLDER_DELETED` audit event fires. |
| **AC-8** | `rule` | FR-5 Upload into current folder — Navigate to `/uploads?path=Engineering%2FSpecs`, drop a PDF `req-v2.pdf` into the upload zone. File is physically at `data/uploads/Engineering/Specs/req-v2.pdf`. URL `GET /uploads/Engineering/Specs/req-v2.pdf` returns 200 with correct Content-Disposition. `uploads.json` record has `folderPath: "Engineering/Specs"` (new field). `FILE_UPLOADED` audit event fires with full normalized path. |
| **AC-9** | `rule` | FR-6 Nested download with containment — `GET /uploads/Engineering/Specs/../../../data/users.json` (path traversal attempt, URL encoded or not) returns 400, no file served; `audit.system` log contains the rejection event with `{ normalizedPathEscape: true }` or equivalent marker. |
| **AC-10** | `rule` | FR-7 Move single file — From root, checkbox-select 1 pre-existing legacy file (`admin.png`), toolbar "Move" button enables (was disabled), click Move, picker opens, select destination folder "Project Beta/v1.0", confirm. Physical file moves from `data/uploads/admin.png` → `data/uploads/Project Beta/v1.0/admin.png`. `uploads.json` `folderPath` for the record becomes `"Project Beta/v1.0"`. Listing at root no longer shows `admin.png`; listing at `/uploads?path=Project+Beta%2Fv1.0` shows it. Deep URL `/uploads/Project%20Beta/v1.0/admin.png` resolves 200. |
| **AC-11** | `rule` | FR-7 Atomic move rollback — Attempt to move 3 files into a destination folder where the **third** file's basename already collides with an existing file. NO files are moved at all (first two remain in source, third still in source). Error flash names the colliding basename and target folder. |
| **AC-12** | `rule` | FR-7 Cycle guard — Attempt to move a file from "Project Beta/v1.0" into destination "Project Beta/v1.0/child-folder" → OK (sibling/descendant move is allowed for files into deeper descendants). Attempt to move a file from "Project Beta" INTO "Project Beta" (identical) or from "Project Beta" into "Project Beta/v1.0" for a file that's ALREADY in v1.0 (no-op duplicate path) → 409/400 rejection. |
| **AC-13** | `rule` | FR-8 Legacy coercion without migration — Wipe the `folderPath` key from `uploads.json` records for 2 legacy files. Restart server. Load `/uploads` root: both legacy files still appear at root. Download both via `/uploads/<basename>` → 200. Navigate subfolders: nested new files still appear correctly inside their folders (newly created rows have `folderPath` field on next write). No migration script was ever run. |
| **AC-14** | `rule` | NFR-5 Audit completeness — After running through the scenario in AC-4 → AC-10, the combined audit JSON log contains **at least 8 distinct action types**: `FOLDER_CREATED` (2), `FOLDER_RENAMED` (1), `FOLDER_DELETED` (1), `FILE_UPLOADED` (1), `FILE_MOVED` (1) = minimum 6, plus the historical `FILE_DELETED` from AC-7 and `FILE_UPLOADED` from the legacy seed data. All 8 include `actor`, `ts`, `clientIp`. |
| **AC-15** | `rubric` | **UI Navigation UX (0-4 scale, pass ≥3)**. Scale anchors: 4 = breadcrumb + folder listing immediately understandable within 2s for a new user; folder rows visually distinct with folder icon before name; folders consistently above files. 3 = usable, minor visual noise or misaligned folder row. 2 = functional but confusing grouping order. 1 = cannot distinguish files vs folders. 0 = broken. |
| **AC-16** | `rubric` | **Toolbar Move UX (0-4 scale, pass ≥3)**. 4 = checkbox-selects clearly highlight rows; disabled state is visually obvious (grey) not subtle; modal folder picker expands/collapses children clearly with chevrons; confirm button only enabled when a valid destination folder is picked. 3 = all functions work, one minor visual defect. 2 = works but missing clear highlight or disabled state. 1 = modal or picker buggy. 0 = cannot move any file. |

## 8. Data Model

### 8.1 Physical storage on disk

```
data/uploads/
├── <legacy_file>.png          (pre-feature; flat — still works at root)
├── <legacy_file>.pdf          (pre-feature; flat)
├── Engineering/
│   ├── Specs/
│   │   └── req.pdf            (nested; URL = /uploads/Engineering/Specs/req.pdf)
│   └── Reports/
│       └── weekly.md
├── Project Beta/
│   └── v1.0/
│       └── admin.png          (moved into here; AC-10 destination)
└── .gitkeep                   (already tracked for repo scaffolding)
```

### 8.2 `uploads.json` record schema (additive; no migration)

```jsonc
{
  "uploads": [
    {
      "id": "u_01H...",
      "originalName": "Requirements Document.pdf",
      "storedName": "req.pdf",
      // NEW FIELD: relative folder path inside uploads root, "" = root.
      // Coerced to "" at read time if absent (legacy rows). Normalized on write.
      "folderPath": "Engineering/Specs",
      "mimeType": "application/pdf",
      "sizeBytes": 482991,
      "uploadedBy": "jdoe",
      "uploadedByDisplay": "Jane Doe",
      "uploadedAt": "2026-09-17T12:00:00Z",
      // NEW FIELD: updatedAt mirrors updatedAt pattern on pages/users/settings.
      "updatedAt": "2026-09-17T12:00:00Z"
    }
  ],
  "updatedAt": "2026-09-17T12:00:00Z"  // top-level updatedAt for whole index
}
```

### 8.3 Audit events (added to existing `AUDIT_LOG_LABEL = "audit"` stream)

New action types: `FOLDER_CREATED`, `FOLDER_RENAMED`, `FOLDER_DELETED`, `FILE_MOVED`. Existing actions (`FILE_UPLOADED`, `FILE_DELETED`) remain unchanged except they now carry `folderPath` on nested events.

## 9. Open Questions — ALL RESOLVED (2026-09-17, questionnaire choices recorded; implementation confirms assumptions A-1 → A-3)

1. **§9.1 Folder ACL model** — **RESOLVED: inherit global role, no per-folder visibility flags.** User selected "Other" (blank custom text) on questionnaire 2026-09-17 → Assumption A-2 accepted. Reader = view-only with all buttons rendered-disabled (never hidden); Editor / Admin = create/rename/delete folders, move files, upload, delete. Server ACL double-checks every write route regardless of client disabled state.
2. **§9.2 Storage model** — **RESOLVED: physical nested subdirectories on disk under `DATA_DIR/uploads/`.** User selected "Other" (blank custom text) on questionnaire 2026-09-17 → Assumption A-1 accepted. Folder state is 100% the physical directory tree; no virtual JSON sidecar. SyncThing replicates the exact tree across nodes 1:1 without extra JSON metadata. Deep URLs `/uploads/Engineering/Specs/req.pdf` resolve natively against the physical filesystem via the wildcard route.
3. **§9.3 No folder move in v1** — **RESOLVED: no folder move in v1 (NG-7 accepted).** Only checkbox-selected files move in v1; folder-move-and-children is explicitly out of scope for v1 and deferred to a future v2 cycle, documented in §3 NG-7.
4. **§9.4 Folder descriptions / metadata** — **RESOLVED: no folder descriptions, colour coding, starred/bookmarked folders, or per-folder modified-by in v1 (NG-4 accepted).** If needed, scope these as a v2 enhancement; v1 keeps the directory tree minimal and SyncThing-simple.
5. **§9.5 Max nesting depth** — **RESOLVED: MAX_FOLDER_DEPTH = 8 segments.** Server constant `MAX_FOLDER_DEPTH = 8` is enforced by `normalizeAndValidateFolderPath()` on every normalized POSIX path (create folder, rename folder, upload folderPath, move destinationPath, listing path). Attempts to create 9+ levels fail HTTP 400 with flash "Max folder depth 8 exceeded." This is a single edit point if the team wants to raise the ceiling later.
