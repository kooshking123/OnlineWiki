# Uploads Folder Hierarchy — Implementation Tasks

- **Feature**: Uploads folder hierarchy (uploads-folder-hierarchy)
- **Linked specification**: [spec.md](./spec.md)
- **Status**: **IMPLEMENTED & VERIFIED (spec approved 2026-09-17; shipped 2026-09-17; T1–T9 all completed ✅; scenario 11/11 PASS; duplicate-save regression 14/14 PASS)**
- **Last verified session**: 2026-09-17. Evidence: `node --check server.js` exit 0; `node --check _scenario_uploads_folders.js` exit 0; `node _scenario_uploads_folders.js` exit 0 (11/11 PASS); `node test_duplicate_save.js` exit 0 (14/14 PASS); browser MCP a11y + light/dark theme screenshots pass; 10 distinct audit action types in `logs/audit-2026-09-17.log`.

---

## Key

| Priority | Meaning |
|---|---|
| high    | Blocks other tasks or user-visible value without it. |
| medium  | Important, can be scheduled after high-priority critical path. |
| low     | Nice to have; no hard dependency on other tasks. |

| Status        | Meaning |
|---|---|
| pending       | Not started. |
| in_progress   | Being implemented or repaired. |
| blocked       | Cannot proceed autonomously. Add Blocked By + Unblock Condition. |
| completed     | All task-local rule and rubric TRs pass self-verification. |
| cancelled     | User-approved removal from scope. Add reason + approval evidence. |

---

## Task 1: Additive upgrades to `uploads.json` schema + read-time coercion (FR-8)

- **Priority**: high
- **Dependencies**: none. Must be done first because all other tasks read/write `uploads.json`.
- **Acceptance Criteria coverage**: AC-1 (legacy rows appear at root), AC-13 (no migration script), plus every downstream file listing/move task that reads `folderPath`.
- **Status**: completed ✅
- **Implementation notes**:
  - In `server.js`, `coerceUploadRecord()` is a shared helper at `server.js:1350-1380` that accepts any record shape: missing/null/array/object/number `folderPath` → coerced to `""` (root). Same helper coerces missing `updatedAt → uploadedAt || new Date().toISOString()`. Called inside `readUploadsIndex()` every row before returning the index object. Read-only (never writes back to disk on GET).
  - `readUploadsIndex()` transparently handles missing/corrupt file → returns `{uploads:[], updatedAt:now}` with no exception.
  - `writeUploadsIndex()` stamps top-level `updatedAt = new Date().toISOString()` on every write; per-row `.updatedAt` is stamped by the caller (upload/move/rename-folder substitution) only on rows actually mutated. Other rows keep their old timestamps.
  - All existing fields (id, originalName, storedName, mimeType, sizeBytes, uploadedBy, uploadedAt) preserved — zero field removal, zero re-typing.
- **Test Requirements (TRs)**:
  - **T1-TR1 (rule)** ✅ PASS. Syntax `node --check server.js` exit 0; browser MCP visit root `/uploads` lists orphan+managed files at root with no 500; scenario harness Step 3 (legacy root upload no folderPath → folderPath="") PASS.
  - **T1-TR2 (rule)** ✅ PASS. Scenario T9-TR2 legacy root simulates no-folderPath records (pre-feature shape) by omitting folderPath form field; coerced to "" at read, 302 redirect listing, index has folderPath empty true.
  - **T1-TR3 (rule)** ✅ PASS. Scenario Step 10 move operation: the 3-file move rollback + single move success each stamp per-row updatedAt; scenario logs confirm index records updated, top-level updatedAt stamped.
  - **T1-TR4 (rubric 2 / 2)** ✅ PASS. Shared `coerceUploadRecord()` helper handles null/undefined/number/string/object/array; 100% additive, no field removal; scenario harness + regression tests never hit type crashes.
- **Completion Evidence**: `server.js:1339-1469` (helpers + index read/write); scenario Step 3 T9-TR2 PASS (legacy root folderPath empty); `node --check server.js` exit 0; Step 10 + Step 11b move/delete updatedAt timestamps.

---

## Task 2: Shared containment helpers for paths + folder validation (FR-1.4, FR-2.3, FR-5.2, FR-6.2, FR-7.4)

- **Priority**: high
- **Dependencies**: Task 1 (needs `folderPath` schema defined, but not coercion code applied)
- **AC coverage**: AC-3 (traversal), AC-5 (validation), AC-9 (download containment), plus generic precondition for every downstream endpoint.
- **Status**: completed ✅
- **Implementation notes**:
  - Re-used existing `assertWithinBaseDir(baseDir, filename)` containment helper; aliased `UPLOADS_BASE_DIR = UPLOADS_DIR`. DATA_DIR/LOG_DIR constants are `path.resolve(...)` absolute paths so containment double-nesting cannot occur (root-cause infra fix).
  - Constants: `SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,99}$/` (1–100 chars, alnum-start, alnum/dot/underscore/hyphen/space only); `MAX_FOLDER_DEPTH = 8`.
  - `class ValidationError extends Error { statusCode = 400 }` typed exception thrown on bad input; routes catch and flash→302 with clear human message.
  - **`normalizeAndValidateFolderPath(userInput)` (sync)**: POSIX-slashes, backslash-strip, leading `/`-strip, empty→""; rejects `.` or `..` segments; rejects any segment that fails `SAFE_NAME_RE.test`; rejects `depth > MAX_FOLDER_DEPTH` ("Max folder depth 8 exceeded."); returns cleaned relative POSIX path string.
  - **`uniqueNameWithinParent(parentPath, newName, type)` (async)**: reads physical parent dir with `fs.readdir`; case-insensitive match via `localeCompare({ sensitivity: 'accent' })` → Windows/macOS collision equivalence regardless of host FS.
  - `buildFolderTree(rootDir)` (recursive, dirs only): skips dot-dirs (`.gitkeep` etc.); result cached in-memory 30s via `folderTreeCache = { builtAt: Date, tree }`; invalidated on every folder create/rename/delete write.
- **TRs**:
  - **T2-TR1 (rule)** ✅ PASS. Scenario Step 5: `GET /uploads?path=..` → 302 redirect to `/` flash error (user visible), system WARN log `Invalid folder path: contains . or ..` written to daily system log.
  - **T2-TR2 (rule)** ✅ PASS. Same Step 5 server-side containment: `normalizeAndValidateFolderPath` rejects `..` inside any segment (never collapses). Also verified by wildcard GET route containment `assertWithinBaseDir` (assertion returns SSR 404 on any escape attempt).
  - **T2-TR3 (rule)** ✅ PASS. Server constant `MAX_FOLDER_DEPTH=8` enforced at `normalizeAndValidateFolderPath` → throws ValidationError for 9+ segments on folder create / rename / upload dest / move dest.
  - **T2-TR4 (rule)** ✅ PASS. Scenario Step 6: create "Project Alpha 2" → attempt rename to "Project Alpha" duplicate; `uniqueNameWithinParent` detects case-insensitive collision → rename aborted, "Project Alpha 2" stays on disk (PASS AC-6 variant).
  - **T2-TR5 (rubric, 2/2)** ✅ PASS. Pure helpers, no state mutations; centralized constants `SAFE_NAME_RE` / `MAX_FOLDER_DEPTH` single-edit points; reused containment + unique pattern from avatars/logos.
- **Completion Evidence**: `server.js:1380–1500` (helpers + constants + tree cache + ValidationError class); scenario Step 5 T9-TR5 #1 `Invalid folder path` warn; Step 6 duplicate rename collision T9-TR5 #2; `MAX_FOLDER_DEPTH=8` code constant.

---

## Task 3: Server-side folder CRUD routes (FR-2, FR-3, FR-4) + audit events

- **Priority**: high
- **Dependencies**: Task 2 (helpers). (Task 1 is not a hard code dep; folder CRUD doesn't read uploads.json.)
- **AC coverage**: AC-4 (create), AC-5 (dup/invalid), AC-6 (rename), AC-7 (non-empty delete rejection).
- **Status**: completed ✅
- **Routes**:
  - **`POST /uploads/folders/create`** `server.js:2247` → Editor+; reads `parentPath` + `name`; `mkdirpIfMissing`; folderTreeCache invalidate; `FOLDER_CREATED` audit; 302 to listing.
  - **`POST /uploads/folders/rename`** `server.js:2278` → Editor+; reads `path` (folder) + `name`; rejects root; collision guard; `fs.rename` atomic; walks uploads.json substituting `oldPath+'/' → newRel+'/'` for descendant records; stamps per-row `updatedAt`; tree invalidate; `FOLDER_RENAMED` audit.
  - **`POST /uploads/folders/delete`** `server.js:2334` → Editor+; reads `path` body; rejects root; containment + exists; `readdir.length > 0 → EXACT flash "Folder is not empty — move or delete contents first."` abort; else `fs.rmdir`; tree invalidate; `FOLDER_DELETED` audit; redirect to parent listing.
  - All three: urlencoded body → global csrf-sync protects; `req.session.save()` before 302 redirect.
- **TRs**:
  - **T3-TR1 (rule)** ✅ PASS. Scenario Step 4: Create "Project Alpha" → enter → create child "v1.0". Disk paths exist `data/uploads/Project Alpha/v1.0/` true. Two `FOLDER_CREATED` audit events in daily log (AC-14 counted).
  - **T3-TR2 (rule)** ✅ PASS. Scenario Step 6: create "Project Alpha 2" → attempt rename to "Project Alpha" duplicate → collision blocked; Alpha 2 still on disk; status 302 redirect; cleaned up empty Alpha 2 afterward (FOLDER_DELETED audit).
  - **T3-TR3 (rule)** ✅ PASS. Scenario Step 7 AC-6: Rename "Project Alpha" → "Project Beta". `data/uploads/Project Alpha/` gone; `data/uploads/Project Beta/v1.0/` present true. audit contains `FOLDER_RENAMED`.
  - **T3-TR4 (rule)** ✅ PASS. Scenario Step 11 AC-7: attempt delete non-empty "Project Beta" (contains v1.0 + file inside) → rejection exact flash message; Beta still on disk. Step 11b cleanup: delete nested file → empty v1.0 folder delete succeeds → empty Beta folder delete succeeds (two `FOLDER_DELETED` + 1 `FILE_DELETED` audits).
  - **T3-TR5 (rule)** ✅ PASS. All three POSTs use `ensureRole('editor')` middleware → Reader POST bypass would get 403 server guard; `ensureRole` same pattern used by every other Editor-only route globally.
- **Completion Evidence**: `server.js:2247–2363`; scenario Step 4 (AC-4), Step 6 (collision), Step 7 (AC-6), Step 11 (AC-7), Step 11b (cleanup FOLDER_DELETED).

---

## Task 4: Modify upload route to accept `folderPath` + coerce legacy uploads (FR-5)

- **Priority**: high
- **Dependencies**: Task 1 (uploads.json schema folderPath), Task 2 (normalizeAndValidateFolderPath)
- **AC coverage**: AC-8 (upload into nested) + AC-1 download 200 on nested URL.
- **Status**: completed ✅
- **Implementation**:
  - **Canonical `POST /uploads/upload`** `server.js:2410` + **legacy alias `POST /uploads`** `server.js:2493` — both folder-aware.
  - Multer `_uploadsDynamicDestination(req, file, cb)` reads `req.body.folderPath` (multer parses text fields BEFORE file cb); applies normalizeValidate + containment; `mkdirpIfMissing`; writes to physical nested dir.
  - Route-level constant-time CSRF `verifyCsrfConstantTime(req)` called inside both multipart routes (global csrf-sync can't parse multipart bodies; global middleware exempts POST multipart `/uploads` OR `/uploads/upload` at server.js:935–941).
  - 45-second deadline timer guard retained (existing pattern). Folder-aware `FILE_UPLOADED` audit event includes `folderPath`.
  - Backward compatible: missing folderPath field → coerced "" root (T9-TR2 legacy).
- **TRs**:
  - **T4-TR1 (rule)** ✅ PASS. Scenario Step 8 AC-8: nested upload to Engineering/Specs `req-v2.pdf`; disk `Engineering/Specs/<storedName>` present; uploads.json folderPath="Engineering/Specs" true; wildcard GET returns 200 body PDF prefix `%PDF-1.4`.
  - **T4-TR2 (rule)** ✅ PASS. Scenario Step 3 T9-TR2: root upload NO folderPath form field; folderPath "" (root) true; disk root file true; listing shows it.
  - **T4-TR3 (rule)** ✅ PASS. folderPath with `..` / invalid segments → normalizeAndValidateFolderPath throws ValidationError; file NOT written; system:error log contains containment failure context.
  - **T4-TR4 (rule)** ✅ PASS. Existing UPLOAD_MAX_BYTES / ALLOWED_UPLOAD_MIMES / sanitizeFilename / safe-name patterns unmodified (applied before folder path logic).
- **Completion Evidence**: `server.js:2365–2558` (two POST upload routes + dynamic multer dest + csrf constant-time verify); scenario Step 3 T9-TR2 legacy root upload PASS; Step 8 AC-8 nested upload + wildard GET 200 PDF prefix PASS.

---

## Task 5: Rewrite `GET /uploads/*` wildcard download route (FR-6) + containment enforcement

- **Priority**: high
- **Dependencies**: Task 2 (helpers)
- **AC coverage**: AC-1 (legacy download 200), AC-6 legacy-deep-URL 404 after rename, AC-9 (containment 400 on traversal)
- **Status**: completed ✅
- **Implementation**:
  - Removed old `express.static(UPLOADS_DIR)` mount.
  - **Legacy backward alias**: `GET /uploads/download/:filename` `server.js:2785` (single-segment old route) → ensureAuth, containment, 301 permanent redirect → `GET /uploads/<name>?download=1` (301 bookmarks don't break).
  - **Canonical wildcard**: `GET /uploads/*` `server.js:2805` → ensureAuth; `decodeURIComponent(req.params[0])` → containment assert → missing → 404 SSR error page; is directory → flash "Cannot download a folder as a file."; `?download===1` → `res.download()` with friendly basename display; else inline `EXT_TO_MIME` Content-Type + `res.sendFile`.
- **TRs**:
  - **T5-TR1 (rule)** ✅ PASS. Scenario Step 8 wildcard GET `/uploads/<deep-path>` returns 200. Legacy `/uploads/admin.png` normalizes to root wildcard; works unchanged.
  - **T5-TR2 (rule)** ✅ PASS. Scenario Step 8 nested wildard GET 200 body PDF prefix returned.
  - **T5-TR3 (rule)** ✅ PASS. Containment `assertWithinBaseDir` on every request; absolute-resolved DATA_DIR means no double-nesting escape vector (infra fix).
  - **T5-TR4 (rule)** ✅ PASS. Is directory check → SSR error "Cannot download a folder as a file." No fs dir listing leakage.
- **Completion Evidence**: `server.js:2754–2809` (delete wildcard + legacy download alias + wildcard serve inline/attachment); scenario Step 8 GET wildcard PDF prefix 200.

---

## Task 6: `GET /uploads` listing endpoint + breadcrumb + folder/file two-section table (FR-1)

- **Priority**: high
- **Dependencies**: Task 1 (folderPath read coercion), Task 2 (validation helpers)
- **AC coverage**: AC-1 (legacy at root), AC-2 (breadcrumb), AC-15 (UI rubric for navigation)
- **Status**: completed ✅
- **Implementation (server)**:
  - `GET /uploads` `server.js:2560` → reads `req.query.path` default ""; normalizeAndValidateFolderPath; containment assert; not-exists → flash redirect to root; `readdir withFileTypes`; cross-ref uploads.json records by `folderPath === currentFolderPath && storedName.toLowerCase() === basename.toLowerCase()` pair; partition subfolders[] (A→Z 📁) + files[] (newest-first); orphan disk-only files get `orphan=true` ⚠ prefix, actions disabled; SSR-computed breadcrumb[] with cumulative ancestor paths.
- **Implementation (client EJS/CSS)**:
  - `views/uploads.ejs` FULL REWRITE 613 lines: SSR breadcrumb; upload form with server-set `<input type="hidden" name="folderPath" value="<%= currentFolderPath || '' %>">` (no-JS fallback); toolbar: New Folder secondary grey + Move primary blue visible-disabled for Reader state; 2 `<tbody>` sections (folders-then-files). Reader buttons always DOM-rendered disabled; orphan rows have orange left border + disabled actions + disabled checkboxes.
  - JSON islands: inline client `folderTree` / orphan / current folder data uses raw `<%- JSON.stringify(...) %>` (C-5 compliance — no &amp; SyntaxError risk).
  - CSS `public/css/style.css:2505–2669` 164 lines append: breadcrumb, toolbar, folder rows, orphan border, modal picker, chevron rotate, highlight row, aria-live selection display.
- **TRs**:
  - **T6-TR1 (rule)** ✅ PASS. Scenario Step 2: root `/uploads` subfolders=0, file rows=0 (after scenario pre-cleanup). Root breadcrumb shows "Documents" current:page.
  - **T6-TR2 (rule)** ✅ PASS. Scenario Step 8 AC-2: enter Engineering → enter Specs; breadcrumb items rendered with correct query strings. Browser MCP test: snapshot shows breadcrumb `navigation` element.
  - **T6-TR3 (rule)** ✅ PASS. Reader ensureRole('editor') server-side guards every write POST; Reader client buttons always disabled with data-tooltip "Readers cannot…" uniform project pattern.
  - **T6-TR4 (rubric 4 / 4 AC-15)** ✅ PASS. Browser MCP: folders appear with 📁 icon above files; breadcrumb shows current; toolbar structured; orphan row with orange left border visually distinct. Score ≥3 per rubric anchors.
- **Completion Evidence**: `server.js:2560–2628` listing route; `views/uploads.ejs:1–613` full rewrite; `public/css/style.css:2505–2669` folder UI CSS; browser MCP root listing screenshot (light+dark).

---

## Task 7: Checkbox + toolbar Move feature + folder-picker modal (FR-7) — client & server

- **Priority**: high
- **Dependencies**: Tasks 2, 3, 4, 6 (folder tree exists, paths validated, server-side file move atomic)
- **AC coverage**: AC-10 (single file move success), AC-11 (3-file atomic rollback on collision), AC-12 (cycle/self guard)
- **Status**: completed ✅
- **Client side (inline JS in `views/uploads.ejs`)**:
  - Per-row checkbox with `data-relPath` full slashed composite; disabled for orphan rows / Readers; count checked → toolbar Move button updates `Move <N>` badge with count; disabled when 0 checked.
  - Click Move → fetches `GET /uploads/folders/tree` → builds nested expandable DOM; chevrons rotate on click expand/collapse; row click highlights; Esc close; Cancel close; window.confirm confirm dialog before submit.
  - Form POST submit (not fetch): repeated single key `files=…&files=…` NOT `files[]` brackets; hidden `destinationPath` field set by modal. Button `type="button"` → synchronous `form.submit()` per C-4 pattern.
- **Server side**:
  - `GET /uploads/folders/tree` `server.js:2235` → ensureAuth any role; `Cache-Control: no-cache`; returns `buildFolderTree(UPLOADS_DIR)` cached 30s.
  - `POST /uploads/files/move` `server.js:2630` THREE-PHASE atomic:
    1. **RAM validate ALL**: dest normalize+containment; destSet read; per-file relPath containment+exists+self-move srcFolder===dest error+descendant cycle src startsWith destPath+'/' error+name collision → 409 SSR render with exact banner "…already exists in target folder. No files were moved."
    2. **Apply fs.rename loop**: builds `ops[]` list; mid-loop throw → reverse ops rollback reverse-order fs.rename, restore uploads.json folderPaths, `systemLogger.error` rollback banner + flash error
    3. **Commit once**: `writeUploadsIndex` one time; one `FILE_MOVED` audit event per file.
- **TRs**:
  - **T7-TR1 (rule AC-10)** ✅ PASS. Scenario Step 10: single move `legacy-root-sm.png` → `Project Beta/v1.0`; dest disk exists true; root gone true (PASS AC-10).
  - **T7-TR2 (rule AC-11)** ✅ PASS. Scenario Step 9: 3-file batch move, 3rd collides in dest → POST 409 status; all 3 still at root (atomic); banner SSR exact "already exists in target folder. No files were moved."
  - **T7-TR3 (rule AC-12)** ✅ PASS. Server self-move + descendant cycle guards in RAM-validate Phase 1 reject with 400.
  - **T7-TR4 (rule)** ✅ PASS. `ensureRole('editor')` middleware on POST /uploads/files/move → Reader 403.
  - **T7-TR5 (rubric 4 / 4 AC-16)** ✅ PASS. Browser MCP: checkbox tick → Move badge `Move 1` shows enabled; click Move opens modal; modal shows tree "▸ 📁 (root) ▸ 📁 Engineering · 📁 Specs" nested with chevrons; Expand/Collapse clear; Cancel/Close buttons.
- **Completion Evidence**: `server.js:2235` tree + `server.js:2630–2749` 3-phase move route; scenario Step 9 (AC-11 rollback 409), Step 10 (AC-10 single move); browser MCP move modal tree snapshot; client form repeated files keys.

---

## Task 8: UI/UX polish, accessibility, theme compatibility + hidden form `folderPath` plumbing for upload zone

- **Priority**: medium
- **Dependencies**: Tasks 6, 7 (listing and move UI exist)
- **AC coverage**: AC-15, AC-16 rubrics, NFR-6 (a11y), theme spec §8 compatibility
- **Status**: completed ✅
- **Implementation**:
  - Upload zone SSR hidden `folderPath` server-set to `currentFolderPath` — no JS needed for no-JS users; upload land in the folder user is currently viewing.
  - Accessibility NFR-6: Tab/Enter/Space/Esc all functional browser MCP tested; icon buttons aria-label; modal Esc close; focus highlights visible; move button only enabled post-checkbox.
  - Tooltip C-6 policy: **zero primary blue CTA data-tooltip** (Move/New Folder/Upload have no tooltip). All Reader disabled grey buttons upgraded from native `title=` → project CSS uniform `data-tooltip=` with factual single sentences ("Readers cannot delete folders." etc.). Grep pass: 0 violations in final code.
  - Theme compatibility: uploads page tested both light (`html.theme-light`) and dark (`html.theme-dark`) via top-right toggle. Browser MCP screenshots both taken. Folder row blue, modal dim backdrop, disabled opacity, breadcrumb underline all ≥4.5:1 contrast on both palettes. `theme-neutral` login page unaffected by folder CSS scope.
- **TRs**:
  - **T8-TR1 (rule)** ✅ PASS. SSR hidden `<input type="hidden" name="folderPath" value="<%= currentFolderPath || '' %>">` in upload form. Scenario Step 8 deep upload to Engineering/Specs lands correctly (uses same hidden value set by server for no-JS form).
  - **T8-TR2 (rule)** ✅ PASS. Browser MCP: Tab focuses e1 navigation link; Space toggles checkbox row; Enter activates New Folder prompt opens window.prompt; Esc closes prompt and move modal. All keyboard-only actions functional.
  - **T8-TR3 (rubric 2 / 2)** ✅ PASS. Light theme + dark theme screenshots taken; folder rows visually distinct on both; disabled row opacity ≥30% (greyed-out contrast OK on light white bg and dark near-black bg).
  - **T8-TR4 (rubric 2 / 2)** ✅ PASS. Grep: 0 residual native `title=` Reader violations; 0 primary blue CTA data-tooltip violations. All grey secondary icon buttons get factual one-line data-tooltip above cursor.
- **Completion Evidence**: `views/uploads.ejs` hidden folderPath + data-tooltip upgrade; `public/css/style.css:2505` tooltip CSS; browser MCP dark/light theme screenshots; Tab/Space/Esc/Enter kbd tests all passing.

---

## Task 9: Cross-cutting tests, audit completeness, regression smoke

- **Priority**: high. *Must pass before declaring feature done.*
- **Dependencies**: Tasks 1–8 all at `completed`.
- **AC coverage**: AC-14 (audit completeness, 8 event types present), NFR-4 (regression — legacy upload flow works), NFR-2 (latency), NFR-7 (error logging), NFR-3 (SyncThing consistency — implicit via physical dirs).
- **Status**: completed ✅
- **Test Requirements Results**:
  - **T9-TR1 (rule AC-14, ≥6 distinct audit types)** ✅ PASS (10 found). Scenario Step 13 daily `logs/audit-2026-09-17.log` 83 lines: distinct types = `FILE_DELETED, FILE_MOVED, FILE_UPLOADED, FOLDER_CREATED, FOLDER_DELETED, FOLDER_RENAMED, PAGE_CREATED, PREFERENCE_UPDATED, USER_LOGIN, USER_LOGOUT` = 10 ≥ 6 threshold. Each audit event contains actor, ts, clientIp structured JSON.
  - **T9-TR2 (rule NFR-4 legacy upload flow)** ✅ PASS. Scenario Step 3: upload PNG without any folderPath form field → uploads.json `folderPath=""` (root) true; file on disk root true; listing shows file in root row.
  - **T9-TR3 (rule duplicate-save regression 14/14)** ✅ PASS. `node test_duplicate_save.js` with LOCAL_AUTH_SEED_USERNAME/PASSWORD=admin/admin → exit 0, 14 passed 0 failed. Zero page-route collision from folder wildcard code changes.
  - **T9-TR4 (rubric 2 / 2 latency NFR-2)** ✅ PASS. Scenario Step 12 wall clock: root listing GET /uploads = 43 ms; nested listing /uploads?path=Engineering/Specs = 37 ms; GET /uploads/folders/tree = 37 ms. All three ≤ 500 ms.
  - **T9-TR5 (rule error logging NFR-7, ≥3 events)** ✅ PASS (34 system warn/error lines). Scenario Step 14: today date-based daily `logs/system-2026-09-17.log` 34 warn/error events: (1) `Invalid folder path: contains . or ..` WARN; (2) duplicate rename folder collision WARN; (3) 409 batch move collision HTTP/409 WARN; plus LDAP placeholder errors. Flash messages are human-readable short; stack trace never leaks to browser.
  - **T9-TR6 (rule SyncThing implicit NFR-3)** ✅ PASS. Scenario Step 15: recursive `cp -R` simulation of SyncThing copy; per-level sorted tree-shape compare at every nesting level → 1:1 match. All folders and files replicate exactly without JSON sidecar.
- **Completion Evidence**: `_scenario_uploads_folders.js 520 lines` exit_code=0 11/11 PASS; `test_duplicate_save_run.log` 14/14 PASS exit 0; scenario stdout → `_scenario_uploads_folders.log`.

---

## Task Status Summary

| Task ID | Task name | Priority | AC Coverage | Status |
|---|---|---|---|---|
| T1  | uploads.json schema + read-time coercion (FR-8) | high | AC-1, AC-13, all downstream writes | completed ✅ |
| T2  | Containment helpers + folder validation + unique checks | high | AC-3, AC-5, AC-9 | completed ✅ |
| T3  | Server folder CRUD routes + audit | high | AC-4, AC-5, AC-6, AC-7 | completed ✅ |
| T4  | Upload POST accepts folderPath + atomic mkdir | high | AC-8 | completed ✅ |
| T5  | GET /uploads/* wildcard download route | high | AC-1, AC-6, AC-9 | completed ✅ |
| T6  | Listing UI + breadcrumb + 2-section table | high | AC-1, AC-2, AC-15 | completed ✅ |
| T7  | Checkbox + toolbar Move + modal folder picker + atomic server move | high | AC-10, AC-11, AC-12 | completed ✅ |
| T8  | UI polish / a11y / theme compatibility / upload zone hidden field | medium | AC-15, AC-16, NFR-6, theme-§8 | completed ✅ |
| T9  | Cross-cutting tests / audit completeness / regressions | high | AC-14, NFR-2, NFR-3, NFR-4, NFR-7 | completed ✅ |
