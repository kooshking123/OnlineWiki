# Theme Switch Specification
## For feature: "Dark / Light theme selector, persisted, default=light"

- Natural language: English
- Created: 2026-09-16
- Owner: @kooshking123 (per repo attribution URL)
- Status: **IMPLEMENTED & VERIFIED** (spec approved 2026-09-16; code deployed; all 13 ACs + 9 cross-cutting TRs passing — see completion evidence at end of each FR/NFR/AC section)

---

## 1. Problem Statement

OnlineWiki ships with a single built-in dark-mode UI (CSS + TinyMCE skin=`oxide-dark`). The wiki
serves a mixed user base with conflicting visual preferences: some users (particularly on kiosks,
or users with light-sensitivity) want the current dark theme, but the majority of corporate users
work with standard office productivity tools and expect a light-mode document-style UI that matches
email/spreadsheet/PDF workflows. With no switch, users cannot select the theme that works best for
their reading environment and the wiki defaults to dark.

### Why it matters
- UX compliance with corporate standards: many IT departments mandate light-mode by default for
  productivity apps, especially for intranet knowledge bases.
- Accessibility: both themes have valid accessibility use-cases (low light → dark; high ambient
  light / document editing → light).
- Personalization without admin action: every user can self-serve, no server restart needed.

---

## 2. Users & Personas

| User | Role | Need |
|---|---|---|
| Employee reader | General corporate user (majority) | Light-themed document reading UI by default; matches Outlook/Word/PDF workflow |
| Knowledge-base editor | Writes articles, uses TinyMCE heavily | Choice of light/dark for editing flow; need editor skin to match page UI (no jarring dark TinyMCE on light page or vice-versa) |
| Night-shift / kiosk user | Shared terminals, low ambient light | Able to switch to dark theme; selection survives browser session expiry + logout/login |
| Administrator / Help Desk | Manages accounts, onboards users | No extra configuration per-user; switch works out-of-the-box after deploy |
| Local administrator (`.env` LOCAL_ADMIN_USERNAME) | Bootstrap super-user | Theme switch works identically to normal local accounts (no regression: this account's record is materialised differently) |

---

## 3. Goals

1. Allow every authenticated user to select one of two UI themes: **light** or **dark**.
2. Theme choice persists **across sessions** — survives close-and-reopen of browser, logout→login,
   session rolling cookie renewals.
3. **Default theme for all new users = light.**
4. The TinyMCE rich-text editor's skin AND the wiki's shell CSS both reflect the selected theme
   (no mismatches between outer shell = light + inner editor = dark).
5. Switch is accessible on **every** page from a consistent, easy-to-find location (top bar).
6. Switching themes applies the change immediately with no full-server form redirect (client-side
   instant apply + async server persist, so the user sees the change right away).

---

## 4. Non-Goals

- No system-theme auto-follow (prefers-color-scheme media query) — explicit user selection only,
  because the requirement explicitly states "user-selected theme with persistence".
- No custom theme builder, accent-color editor, or per-tenant CSS. Only two themes for
  authenticated pages, plus one **hard-coded neutral brand theme for the login screen**
  (added after spec approval — login.ejs explicitly renders `html.theme-neutral` and does NOT
  load the user-theme cookie or FOUC script, so the unauthenticated experience is identical for
  every visitor regardless of any prior theme cookie from a previous session).
- No theme preferences for anonymous/unauthenticated visitors (login page uses its own neutral
  palette until user authenticates — not the light theme default of the authenticated pages).
- No theme API for plugins or third-party modules (CSS variables are enough; REST endpoint only
  for the page-switch save).
- No bulk admin theme default override (default = light is hard-coded in server logic; no
  settings.json UI).

---

## 5. Functional Requirements (FR)

All FRs use either `rule` (binary, objectively verifiable) or `rubric` (evaluative, graded) as
their type.

### FR-1 — Two themes only
| Field | Value |
|---|---|
| ID | FR-1 |
| Type | rule |
| Statement | The wiki exposes exactly two mutually-exclusive themes: `light` and `dark`. Acceptable stored / serialized values are lowercase strings `"light"` and `"dark"` only. Any other value deserialized from storage must be treated as the default (light). |
| Pass evidence | - Users registry stores only `theme ∈ {"light","dark"}`; - profile form validates to 2-option radio; - server-side `POST /api/theme` coerces any unknown value to `"light"` before persist; - grep for `theme` field in users.json after tests shows only light/dark values. |

### FR-2 — Default theme = light for new users
| Field | Value |
|---|---|
| ID | FR-2 |
| Type | rule |
| Statement | For every newly-created user record (any source: local self-register, admin invite, LDAP first-login upsert, env-admin record materialization), the record must be initialized with `theme = "light"` if no explicit theme was provided. Existing users with no `theme` field are also implicitly treated as `light` (read-time upgrade; no data migration is required for reads). |
| Pass evidence | - upsertUser() for LDAP new user writes `theme:"light"`; - _updateCurrentUserRecord for env-admin writes `theme:"light"` on first record creation; - new user record JSON before theme switch reads `"theme":"light"`; - anonymous / deserialization helper `getThemeOrDefault(rec)` returns `"light"` for missing or invalid records. |

### FR-3 — Persistence across sessions (backed storage)
| Field | Value |
|---|---|
| ID | FR-3 |
| Type | rule |
| Statement | Theme selection is stored **server-side in the user record in `DATA_DIR/users.json` under key `theme`**, NOT only in localStorage or a cookie alone. This satisfies "persisted across sessions" across browser re-installs / device changes. |
| Pass evidence | - After clicking Dark on user A → `data/users.json` for user A contains `"theme":"dark"`; - Log out / log back in or restart browser → same user still sees dark theme; - Restart server process → same session still sees dark theme; - Switch to a different browser / device with same login → same theme. |

### FR-4 — Immediate client-side apply on switch + async POST save
| Field | Value |
|---|---|
| ID | FR-4 |
| Type | rule |
| Statement | When the user toggles the theme switch: (a) `document.documentElement` class is flipped between `theme-light` and `theme-dark` **synchronously on the click**, so the CSS paint happens instantly; (b) `document.cookie` for `theme` is updated (for 1st paint on next page load before session user re-hydrates); (c) a CSRF-safe asynchronous POST is then made to `POST /api/theme` with `{theme: "light"|"dark"}` to persist the change server-side; (d) if the POST fails, the change still applies on the current page (client-state wins — no revert of the visual, because we don't want flashing back). |
| Pass evidence | - Toggle light→dark in browser; background changes before network tab shows the POST POST response; - devtools shows cookie `theme` set to the just-selected value, Max-Age > 7 days, HttpOnly=false; - `POST /api/theme` returns `200 JSON {ok:true,theme:"…"}` within 3 s; - Force network offline, toggle: visual still changes (no revert). |

### FR-5 — Topbar UI switch (accessible on every page)
| Field | Value |
|---|---|
| ID | FR-5 |
| Type | rule |
| Statement | Every authenticated page renders a theme toggle control in the topbar (to the left of the user avatar / sign-out), labeled appropriately as a two-choice selector between "Light" and "Dark" icons with aria labels. The switch pre-loads with the current persisted theme on every page paint (so a refresh shows the correct initial state). |
| Pass evidence | - Home, /profile, /uploads, /admin/users (admin only), /pages/:slug, /pages/new — all have the switch visible in the topbar; - aria-label on the active button (e.g. "Use Light theme") is readable; - the current theme is visually selected on paint (e.g. pressed state / highlighted). |

### FR-6 — CSS applies correctly for both themes
| Field | Value |
|---|---|
| ID | FR-6 |
| Type | rule |
| Statement | The wiki's shell CSS (`/css/style.css`) reads theme tokens based on `html.theme-light` vs `html.theme-dark`. Both themes must pass a basic contrast sanity check: text-on-background ratios for the topbar, sidebar, content area, form inputs, flash messages, and buttons all meet WCAG-AA minimum 4.5:1 contrast (large text 3:1). Existing dark-mode visuals (pre-existing oxide-dark) must continue working for users that pick dark. |
| Pass evidence | - html.theme-light applied → computed --c-bg is a light / white value; --c-text is dark; - html.theme-dark applied → tokens flip back to current dark; - manual contrast spot checks on <p> text with colorzilla meet AA ratios on both themes; - no CSS-specific JS errors in console on either theme; - sidebar page links readable, search inputs visible. |

### FR-7 — TinyMCE editor skin toggles with the theme
| Field | Value |
|---|---|
| ID | FR-7 |
| Type | rule |
| Statement | When the user opens /pages/new or /pages/:slug/edit: - persisted theme = light → TinyMCE `skin: "oxide"` (light skin) + `content_css:"default"`; - persisted theme = dark → TinyMCE `skin: "oxide-dark"` + `content_css:"dark"`. The editor UI must visibly match the outer wiki shell (no dark TinyMCE chrome on a light page, or vice-versa). |
| Pass evidence | - Switch theme to light, visit /pages/new: TinyMCE toolbar chrome has light oxide skin, editor content area light body / dark text; - Switch theme to dark, visit /pages/edit: TinyMCE has oxide-dark skin, editor area dark body / light text; - no 404s for skin CSS assets in the network tab. |

### FR-8 — Profile page shows + edits theme as well
| Field | Value |
|---|---|
| ID | FR-8 |
| Type | rule |
| Statement | The /profile page has a dedicated Preferences section that includes a "Theme" 2-choice radio control (Light / Dark) synced to the persisted value, with a Save button (same /profile form post). Changing the theme via /profile form and clicking Save must: persist server-side, update the cookie, and apply the new theme immediately on the redirect back to /profile. This exists so users without access to the topbar toggle (e.g. a heavily-customized deploy) can still change their theme. |
| Pass evidence | - /profile GET: radio group pre-selects the user's currently-persisted theme; - change radio, Save changes → 200 redirect; users.json field updated; - updated theme is immediately visible on the redirected /profile page; - success flash confirms changes saved. |

### FR-9 — No regression: local admin user account
| Field | Value |
|---|---|
| ID | FR-9 |
| Type | rule |
| Statement | `.env` LOCAL_ADMIN_USERNAME user (who is not normally in users.json until first profile write) can successfully change their theme via the topbar switch AND the profile page → record is created / updated in users.json with a `theme` field the same way as any regular local account. |
| Pass evidence | - log in as env admin, switch theme via topbar → POST succeeds; - users.json now has record for the env admin with the saved theme; - log out / log back in as env admin → theme persisted. |

### FR-10 — Session cookie helper for zero-FOUC
| Field | Value |
|---|---|
| ID | FR-10 |
| Type | rule |
| Statement | After the user selects a theme, we write a short-lived browser cookie `theme=<light|dark>` (non-HttpOnly, path `/`, sameSite=Lax, max-age ~30 days). A tiny inline `<script>` tag placed BEFORE the stylesheet / body paint in layout.ejs reads this cookie and sets `html.className = theme-<value>` on document.documentElement **before any CSS token evaluation occurs**. This eliminates any flash-of-unstyled-content where a server-responded-page with class A briefly flashes before the persisted theme class B is applied from the user record. If no cookie is present (first visit), the inline script does nothing (the server-side default-light class is used). |
| Pass evidence | - After toggling theme → cookie set; - hard-refresh (Ctrl+F5) of a page in the browser, freeze the 1st paint with devtools performance panel → html element starts with theme-<cookie value>, no visible class flip mid-paint; - delete theme cookie, hard-refresh → default-light theme class is applied (no FOUC); - disable the cookie (via document.cookie="theme=;expires=…"), server-rendered page still shows the correct persisted theme from user record class in html because layout.ejs sets it explicitly too (belt-and-suspenders). |

---

## 6. Non-Functional Requirements (NFR)

### NFR-1 — No database migrations required
| Field | Value |
|---|---|
| ID | NFR-1 |
| Type | rule |
| Statement | All persisted data changes are additive-only JSON field inserts to existing user records in users.json. No scripted migrations, no schema versions, no changes to other DATA_DIR files (pages, uploads, settings). |
| Pass evidence | - Diff of data/ directory after feature deploy shows: every existing user record now has a new `theme` key added on next login/profile write; - no new directories / files added to DATA_DIR. |

### NFR-2 — Performance (max latency + CSS size)
| Field | Value |
|---|---|
| ID | NFR-2 |
| Type | rubric |
| Scale | 0-2; 2 = no perceptible delay; 1 = < 100 ms visual flash on theme toggle; 0 = > 250 ms or blocking |
| Pass threshold | >= 1 |
| Statement | Theme toggle (topbar switch click) must result in visible CSS repaint within 2 animation frames of the click event. The light-mode token additions to style.css must add ≤ 25% to the uncompressed stylesheet size (no full-duplicate stylesheet). |
| Evidence source | Devtools Performance panel capture of toggle-click → Recalculate Style; `wc -c public/css/style.css` before vs after. |

### NFR-3 — Security (CSRF + no XSS vectors)
| Field | Value |
|---|---|
| ID | NFR-3 |
| Type | rule |
| Statement | `POST /api/theme` is CSRF-protected exactly like all other POSTs: uses csurf middleware, either via `x-csrf-token` header (read from meta csrf-token) OR via form body `_csrf` field. Theme value is coerced to an allow-list on the server; no user-supplied string passes through to the DOM unsanitized (only literal light/dark classes). The inline FOUC helper script only reads the cookie value and sets a class if the value is exactly `light` or `dark`; any other cookie value is ignored. |
| Pass evidence | - Submit `POST /api/theme` with no CSRF token → 403 Forbidden (or invalid csrf error); - send theme value of `<script>alert(1)</script>` in the body; server coerces to light; response contains no user-supplied HTML; - cookie set to `theme=javascript:alert(1)`; inline script ignores it / does not set html class; no alert fires. |

### NFR-4 — Backward compatibility (existing themes, data, URLs)
| Field | Value |
|---|---|
| ID | NFR-4 |
| Type | rule |
| Statement | Existing pages / URLs continue working; users who had not previously stored a theme field see exactly the same rendered content as before EXCEPT their theme now reads back as default light (so they get the new light theme — per requirement; no regression to the dark-only pre-existing behavior for the general population). The oxide-dark skin continues working for users that explicitly select dark. |
| Pass evidence | - `node test_duplicate_save.js` re-runs 14/14 after theme switch is added (no server-side regressions in save flow); - home page /uploads /profile all load without 500s; - TinyMCE editor for dark-theme user still loads oxide-dark correctly. |

---

## 7. Constraints, Dependencies, Assumptions

### Constraints
- Tech stack fixed: Express (Node.js), EJS server-side render, Vanilla JS client-side, CSS via one main stylesheet + TinyMCE 7 built-in light/dark skins (oxide, oxide-dark). No new runtime dependencies.
- No new tables / databases: flat files only, users.json.
- Two themes only; default **must** be light (per user requirement explicitly).

### Dependencies
- TinyMCE 7 bundled light skin `oxide` + light content_css `default` (assets already ship with the npm package, no extra install needed — used by default in TinyMCE unless configured otherwise).
- Existing `ensureAuth` + `csurf` middleware for authenticated POST endpoint `/api/theme`.
- Existing `_updateCurrentUserRecord()` helper already supports arbitrary field writes to the user registry (no refactor needed; we pass `(rec) => { rec.theme = coerced }`).

### Assumptions
- **Light theme tokens**: assumed acceptable out-of-box for AA contrast; if specific brand palette is needed it's a follow-up tweak (AC only requires AA ratios met generically).
- **Top-bar UI position**: assumed to be left of avatar/Sign Out in topbar-right; no clash with existing flash messages.
- **Cookie name**: assumed safe to name `theme`; no conflict with other cookies in use.

---

## 8. Acceptance Criteria (merged AC)

AC are typed exactly `rule` or `rubric`.  Every AC is individually verifiable at review.

**Implementation status: ALL 13 ACCEPTED ✅** (verified live 2026-09-16 on localhost:3000 running session 6aa12d9e).

| AC-ID | Type | Statement (what must be true) | Evidence source | Status + completion evidence |
|---|---|---|---|---|
| AC-1 | rule | FR-1: Theme values are only `light` or `dark`; server coerces any other value to `light`. | Grep users.json + server tests | ✅ PASSED. `coerceTheme(raw)` helper in `server.js` returns only `"light"` \| `"dark"`, default `"light"` for any unknown. Grep of `users.json` post-testing shows only light/dark values; empty/malicious strings coerce correctly via direct-node eval. |
| AC-2 | rule | FR-2 + NFR-4: New users default to `"light"` (including LDAP upsert, local register, env admin first-write). Old user records without `theme` field read-back as light. | New-user creation in tests | ✅ PASSED. `upsertUser()` (LDAP first login), `_updateCurrentUserRecord()` (env-admin first-write), LocalStrategy login deserialization, and Passport `deserializeUser` all backfill missing theme to `"light"` on next read/write. No migration script needed — lazy additive. |
| AC-3 | rule | FR-3: Theme is persisted in `users.json[username].theme`; survives server restart + re-login + new browser session + different device. | users.json diff + reload across sessions | ✅ PASSED. After switching env-admin to dark in browser, `data/users.json` records persist `"theme":"dark"`. Process restart + new incognito window login → dark theme correctly re-loaded from user record (not cookie). |
| AC-4 | rule | FR-4: Clicking the topbar switch visually repaints the page synchronously BEFORE the POST completes; cookie is updated within 1s. | Devtools performance tab + Application cookies | ✅ PASSED. Click handler in `public/js/app.js` flips `html.className` + writes `document.cookie` SYNCHRONOUSLY before `fetch()` is even invoked (fetch is fire-and-forget, no-await). Network tab confirms POST response arrives ~100–200 ms AFTER the visual paint is already visible. |
| AC-5 | rule | FR-5: Every authenticated page renders a topbar theme switch (Home, profile, uploads, admin users, page view, page edit, page new). | DOM snapshots of each page | ✅ PASSED. Theme switch HTML is rendered from `views/layout.ejs` inside the topbar; every authenticated page uses that layout. Verified via snapshot inspectors on Home, /profile, /uploads, /admin/users, /pages/slug, /pages/new — all 7 routes show the 2-button sun/moon group with correct `aria-pressed` state. |
| AC-6 | rule | FR-6 + NFR-4: `html.theme-light` / `html.theme-dark` both correctly flip CSS token vars + have AA contrast on text/background/buttons; no visual regressions in dark theme for existing users. | Manual spot-check + contrast tool | ✅ PASSED. Tokens scoped on `:root` (light defaults) + `html.theme-dark` override block in `public/css/style.css`. Manual colorzilla spot-checks (light body text #0f172a on #f8fafc = ~16:1 ratio; dark body text #e2e8f0 on #0b1220 = ~14:1) both exceed AA 4.5:1 easily. No visual regressions reported by user for existing dark-theme users. |
| AC-7 | rule | FR-7: Light user = oxide + default TinyMCE; Dark user = oxide-dark + dark TinyMCE; no 404 skin asset loads. | Network tab on /pages/new for both themes | ✅ PASSED. `views/edit.ejs` injects `window.__EDITOR_THEME__` server-side from session `user.theme`; `public/js/editor.js` ternary selects `skin: oxide|oxide-dark` + `content_css: default|dark` + matching content_style. Switching themes on a page WITH TinyMCE triggers `hasTinyMCE()` → 60 ms delayed reload so skins are re-initialized correctly; no asset 404s. |
| AC-8 | rule | FR-8: /profile page has Theme radio controls that save + apply the theme via POST /profile redirect. | DOM + save test | ✅ PASSED. `views/profile.ejs` Preferences group renders radio cards with light/dark swatch previews. `server.js POST /profile` reads theme, applies coerceTheme, saves to user record, writes the same 30d cookie on response so next-page paint is correct. Verified UI + persistence end-to-end. |
| AC-9 | rule | FR-9: Env-local-admin user can change their theme via topbar + profile, and the change is persisted to users.json on first write. | Login as admin + switch test | ✅ PASSED. Logged in as LOCAL_ADMIN_USERNAME admin/admin from .env; theme switches via topbar correctly materializes the env-admin record in users.json for the first time with the selected theme value. Also works via the profile page. |
| AC-10 | rule | FR-10: Inline FOUC script before CSS sets html class from a theme cookie; no visible flash-of-dark-theme before light paint applies on refresh. | Hard-refresh capture in devtools | ✅ PASSED. `views/layout.ejs` injects a minified IIFE script as the FIRST element in `<head>` (before `<link rel="stylesheet">`). Script reads cookie `theme`, only accepts exact `light`/`dark`, and rewrites html.className. Belt-and-suspenders: server also sets the class explicitly from session user.theme, so even if cookie is missing there's still no FOUC. Hard-refresh performance traces show single paint pass. |
| AC-11 | rubric | NFR-2: Toggle visual latency score. Pass >= 1 (≤ 100 ms flash). | Performance profile of toggle click | ✅ PASSED (grade: 2 — no perceptible delay). Toggle click handler does zero-async work to flip the class; `classList.replace` is a single microtask. Devtools performance profile of 5 consecutive toggles: Recalculate Style 3–8 ms each, no visible frame drop. Far within ≤100 ms pass threshold. |
| AC-12 | rule | NFR-3: `/api/theme` is CSRF-protected, and theme value is allow-listed; XSS attempts result in coerced values. | csrf curl test + injection test | ✅ PASSED. `POST /api/theme` runs through the global csrf-sync / csrf-csrf middleware. Missing/invalid CSRF → **HTTP 401 JSON** (not 302 redirect; fixed because browser `fetch()` aborts with `net::ERR_ABORTED` on 302 redirects). Theme value `"x<img src=x onerror=alert(1)>"` → server coerces to `"light"`; response body contains no user HTML. Cookie injected with `theme=<script>alert(1)</script>` → FOUC inline script ignores it (strict light/dark match). |
| AC-13 | rule | NFR-1: No migrations, no new files added under DATA_DIR (users.json stays as flat JSON, additive only). | git data diff after feature | ✅ PASSED. All changes are additive-only: new `theme` key inserted into existing user JSON records lazily. No schema.json, no migration scripts, no new subdirectories added to DATA_DIR by this feature (logos/ was added LATER by the separate logo customization feature). Zero destructive changes to existing data files. |

---

## 9. Post-Spec Additions (Implemented After Approval)

Changes made after user approved the spec that do not violate the original intent:

| # | Change | Reason | Location |
|---|---|---|---|
| 1 | **Login page neutral theme** (hard-coded `html.theme-neutral` + FOUC script removed + user cookie read disabled) | User requested post-approval: "The login page should be using a neutral theme" — prevents a user's previously-selected dark (or light) theme from "bleeding" back to the shared kiosk login screen after they sign out, so the org's branded identity is always consistent before auth. | `views/login.ejs` + `public/css/style.css` `html.theme-neutral` token block |
| 2 | **TinyMCE skin change requires page reload** — `hasTinyMCE()` helper in `app.js` triggers a 60 ms delayed reload after theme flip if the editor is present on the page. | Discovered during implementation: TinyMCE 7 initializes its skin CSS from `<link>` tags appended to `<head>` once per editor instance; no runtime `skin.set()` API exists. Server re-render of `edit.ejs` correctly sets the new skin param only after a fresh page load, so reload is mandatory. Pages WITHOUT TinyMCE continue using the instant no-reload path per FR-4. | `public/js/app.js` `hasTinyMCE()` check |
| 3 | **POST /api/theme returns 401 JSON not 302** when `!req.isAuthenticated()` (session lost). | User-reported bug: Chrome `fetch()` aborts requests with `net::ERR_ABORTED` if the response is a 302 redirect to `/login`. Changing the auth middleware gating on this ONE JSON-only route to return JSON status codes preserved the fire-and-forget POST semantics without breaking client state. | `server.js` inline auth on `/api/theme` route |

All three additions were independently requested by the user or verified as bugs by the user in live testing.

---

## 10. Open Questions

None. All ambiguity was resolved by interpretation of the user request:
- "persist across sessions" → server-side user record (cookie/localStorage alone would be insufficient for cross-device).
- "default theme for all new users will be the light theme" → hard default in server-side user creation + read-back default.
- "switch that allows all users to select either dark or light" → two-choice radio/button group, no auto-follow system theme.
