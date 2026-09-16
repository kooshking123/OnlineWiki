# Implementation Tasks — Theme Switch
## For spec: [spec.md](./spec.md)
- Created: 2026-09-16
- Status: pending implementation (after user approval of spec + tasks)

Each task maps one-or-more ACs from spec.md.  Task-local Test Requirements (TR)
are typed `rule` / `rubric` exactly as in spec.md.

---

## Task 1: User registry schema + default light theme

**Goal**: Anywhere the server creates or reads a user record, serialises / parses a
string `theme` field with valid values `light` | `dark`, and initialises new
records to `theme:"light"` on first creation.

### Files
- `server.js`
  - `upsertUser()` (LDAP first-login + existing last-login refresh, line ~1110):
    add `theme: 'light'` on new-user creation block; if theme missing on existing
    user, set it to 'light' on the existing record during the refresh pass.
  - `_updateCurrentUserRecord()` (profile + avatar helper, line ~2486): add `theme:'light'`
    in the record-initialisation block if the record doesn't already exist.
  - Passport LocalStrategy callback (line ~534): if we load a record from disk
    that's missing `theme`, back-fill it to 'light' before returning the user to
    done() — so existing-accounts-from-legacy-data are treated as default light
    (AC-2 read-back behaviour).
  - Passport `deserializeUser` fallback paths: if user record theme is missing,
    propagate theme: 'light' into the session user object so `res.locals.user.theme`
    is always populated (AC-2).
  - Add helper function `coerceTheme(raw)` anywhere theme is written from user
    input: returns `light` | `dark` only, defaulting to `light` for any unknown
    value (AC-1 server-side enforcement).

### Dependencies
- None — foundation for every other task.

### Test Requirements (TR)
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T1-TR1 | rule | New LDAP user → upsertUser creates record with `theme:"light"`. | Manual: create fresh LDAP-mapped user; users.json confirms field. |
| T1-TR2 | rule | Legacy user record (no `theme` field) loaded via local-password login or profile update → back-filled to `"light"` on next write/read. | users.json diff after login. |
| T1-TR3 | rule | coerceTheme returns `"light"` for: undefined, null, `"Dark"`, `""`, `"light"`, `"dark"`, `"<script>alert(1)</script>"`; only `"dark"` (case-insensitive trim) returns `"dark"`. | Node unit evaluation in test script. |
| T1-TR4 | rule | Env-admin record, on first-ever write via theme update, is created with the user-supplied theme (coerced). | env admin manual test. |

### Status: pending
### Completion Evidence: _(filled in during Implement)_

---

## Task 2: Server endpoints `POST /api/theme` + session user theme propagation

**Goal**: Persist user-selected theme server-side (AC-3), and propagate the current
user's theme into `res.locals.user.theme` so every page render has access to it.

### Files
- `server.js`
  - Add POST route `/api/theme`, authenticated (`ensureAuth`), body-parser JSON,
    csurf-protected (expects `x-csrf-token` header OR `_csrf` field).
  - Reads `req.body.theme`, calls `coerceTheme()`, calls `_updateCurrentUserRecord()`
    with `(rec)=>{ rec.theme = coerced; }`.
  - Returns `200 JSON { ok:true, theme: coerced, persisted:true }`.
  - Also **writes an HttpOnly=false, 30-day, SameSite=Lax, Path=/ cookie** named
    `theme` with the coerced value, on the response (used by FOUC inline script
    for first paint on subsequent page loads).
  - Audit-log a `PREFERENCE_UPDATED { field:"theme", old, new, username }` event.
  - Serialize session user so theme is present (if not already, due to legacy data),
    either by augmenting session user in-place after update, or by ensuring
    deserializeUser always populates it.

### Dependencies
- Task 1 (coerceTheme + user record init).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T2-TR1 | rule | `POST /api/theme` with no CSRF token → HTTP 403. | curl test. |
| T2-TR2 | rule | Authenticated POST with `{ theme: "dark" }` + valid CSRF → 200 JSON `{ok:true,theme:"dark"}`; `Set-Cookie: theme=dark; …` header present; users.json updated. | Devtools network + file diff. |
| T2-TR3 | rule | POST with `{ theme: "<img src=x onerror=alert(1)>" }` → coerces to `"light"`, response has no HTML. | Server payload test. |
| T2-TR4 | rule | Audit log contains one PREFERENCE_UPDATED entry per successful POST. | audit log grep. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 3: `views/layout.ejs` — inject theme class on `<html>`, inline FOUC script, add topbar switch UI

**Goal**: Every authenticated page renders
- `<html class="theme-light">` or `<html class="theme-dark">` (server-side default class, from session `user.theme` or default light).
- A tiny inline `<script>` in `<head>` BEFORE the CSS `<link rel="stylesheet" href="/css/style.css">` that reads browser cookie `theme`, and if the value is exactly `light` or `dark`, overwrites the html class to `theme-<value>`. This is belt-and-suspenders: server class is the correct persisted value, cookie class corrects for any post-save cookie-not-yet-synced session and eliminates FOUC.
- Add a theme toggle UI in topbar-right, left of user avatar.  Use 2 icon buttons: Sun (light) and Moon (dark), wrapped in aria-labelledby group, with the currently-selected option visually highlighted (pressed state).
- The switch reads current theme from the server-side inline `window.__THEME_INITIAL__` JSON literal.  On click: client code (Task 5) will flip the visual + do the POST.

### Files
- `views/layout.ejs`
  - Add `theme` resolution scriplet at the top of `<head>`: serverUserTheme =
    (user && user.theme === 'dark') ? 'dark' : 'light'.
  - Set `<html class="theme-<%= serverUserTheme %>" …>`.
  - Add inline `<script>` as the **very first** element in `<head>` (before link
    rel=stylesheet).  Source:
    ```js
    (function(){try{var c=document.cookie.split(';').find(s=>s.trim().startsWith('theme='));if(!c)return;var v=decodeURIComponent(c.split('=')[1]).trim().toLowerCase();if(v==='light'||v==='dark'){var el=document.documentElement;el.className=el.className.replace(/\btheme-(?:light|dark)\b/g,'');el.classList.add('theme-'+v);}}catch(_){}})();
    ```
  - In topbar-right, before the user-chip link, insert the theme toggle group:
    ```html
    <div class="theme-switch" role="group" aria-label="Theme selector">
      <button type="button" class="theme-btn theme-btn-light <%= serverUserTheme==='light'?'theme-btn-active':'' %>" aria-pressed="<%= serverUserTheme==='light' %>" data-theme="light" title="Use Light theme">
        <svg>sun icon</svg>
      </button>
      <button type="button" class="theme-btn theme-btn-dark <%= serverUserTheme==='dark'?'theme-btn-active':'' %>" aria-pressed="<%= serverUserTheme==='dark' %>" data-theme="dark" title="Use Dark theme">
        <svg>moon icon</svg>
      </button>
    </div>
    ```
  - Add an inline `<script>` snippet just before the closing `</body>` app.js that
    writes `window.__THEME_INITIAL__ = "<%= serverUserTheme %>";` (literal string,
    html-escape server value to be safe).

### Dependencies
- Task 1 (user.theme always populated server-side).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T3-TR1 | rule | `<html>` class is theme-light for a user with persisted light theme; theme-dark for persisted dark theme. | View source + DOM snapshot. |
| T3-TR2 | rule | Inline head FOUC script: set `document.cookie="theme=dark"`, hard-refresh a light-user page → first paint class is `theme-dark` (cookie override). Then clear cookie, refresh again → back to server-provided class. | Devtools performance trace + class watcher. |
| T3-TR3 | rule | FOUC script ignores cookies with values outside light/dark (e.g. `theme=<script>` → no change, no script error). | Manual injection test. |
| T3-TR4 | rule | Every authenticated page (home, profile, uploads, /page/:slug, /pages/new, admin/users) contains the 2-button theme switch group with aria-labels and aria-pressed state matching current theme. | DOM snapshots of each route. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 4: CSS — define both themes via CSS variables on `.theme-light` / `.theme-dark`

**Goal**: Move all theme-specific colors to CSS custom properties on `:root` and
scope-redeclare them on `.theme-light` (default + explicit) and `.theme-dark`.
All existing CSS selectors that currently use hard-coded dark-mode colours must
reference the variables instead.

### Files
- `public/css/style.css`
  - Define on `:root` (default = light):
    ```css
    :root {
      --c-bg:              #f8fafc;
      --c-bg-elev:         #ffffff;
      --c-sidebar-bg:      #f1f5f9;
      --c-topbar-bg:       #ffffff;
      --c-content-bg:      #ffffff;
      --c-card-bg:         #ffffff;
      --c-border:          #cbd5e1;
      --c-border-soft:     #e2e8f0;
      --c-text:            #0f172a;
      --c-text-muted:      #475569;
      --c-heading:         #020617;
      --c-accent:          #2563eb;
      --c-accent-hover:    #1d4ed8;
      --c-accent-soft:     #dbeafe;
      --c-danger:          #dc2626;
      --c-danger-hover:    #b91c1c;
      --c-danger-soft:     #fee2e2;
      --c-success:         #15803d;
      --c-success-soft:    #dcfce7;
      --c-link:            #2563eb;
      --c-link-hover:      #1d4ed8;
      --c-shadow:          0 10px 15px -3px rgba(15,23,42,0.08);
      --c-glass:           rgba(255,255,255,0.85);
    }
    html.theme-light { /* re-declare identical :root values for clarity */ }
    html.theme-dark {
      /* current existing dark theme tokens — copy all current theme into here */
    }
    ```
  - Scan entire existing `style.css` for hex colour references, replace them with
    var(--c-xxx) references where appropriate.
  - Profile card / avatar cropper canvas backgrounds: for theme-light use neutral
    gray-100, for theme-dark use slate-900 / existing 111827 value.
  - Add styles for `.theme-switch`, `.theme-btn`, `.theme-btn-active` (selector
    group in topbar): border radius, hover states, active-vs-inactive contrast.
  - Keep contrast AA compliant on both themes.

### Dependencies
- Task 3 (html.theme-* classes exist).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T4-TR1 | rule | On theme-light: --c-bg computed on body is light value; on theme-dark it's dark. | Devtools computed style. |
| T4-TR2 | rubric | Contrast on common typography / buttons / inputs.  Scale 0-2; 2 = all AA; 1 = 1 minor fail; 0 = multiple fails. Pass ≥ 1. | axe/colorzilla sample of 5 key surfaces on both themes. |
| T4-TR3 | rule | Theme-switch button group renders visibly different active button (pressed/highlighted). | Visual screenshot + active class present. |
| T4-TR4 | rule | Size increase of style.css ≤ ~25% vs pre-feature size. | `wc -c` before / after. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 5: Client-side JS — topbar switch handler (`public/js/app.js`)

**Goal**: Read `window.__THEME_INITIAL__`, apply theme class synchronously on
click, update cookie, POST to /api/theme.

### Files
- `public/js/app.js`
  - Read initial theme from `document.documentElement.className` match for
    `/\btheme-(light|dark)\b/`, or fall back to `window.__THEME_INITIAL__` if it
    exists, or `"light"`.
  - Set up click handlers on `.theme-btn[data-theme]`:
    1. Call `e.preventDefault()` (no form / no navigation).
    2. Read `newTheme = this.dataset.theme` (sanitise: only light|dark, ignore other).
    3. If newTheme == current theme: no-op (toggle not needed).
    4. Else: flip current var, swap html classes (remove old theme-*, add new),
       swap active class + aria-pressed on the 2 buttons, flip pressed visual state.
    5. Update cookie `theme=<newTheme>; Path=/; SameSite=Lax; Max-Age=${30*86400}`
       (no HttpOnly so head FOUC script can read it).  This must happen BEFORE
       any network call so refresh-then-fail still has the new cookie.
    6. Async-fetch `POST /api/theme`, body `JSON.stringify({ theme: newTheme })`,
       with Headers: `Content-Type: application/json`, `x-csrf-token: <from meta>`.
       Do not await; fire-and-forget (no revert if it fails per AC-4).
       If response not ok → console.warn only (no UI revert).
  - Keep backwards compatible: if `.theme-switch` is not on the page, the listener
    attachers do not throw (early return).

### Dependencies
- Tasks 3 (UI markup), 4 (CSS classes), 2 (POST /api/theme endpoint live).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T5-TR1 | rule | Click light button on dark user → html class changes within 1 frame; cookie theme=light; POST /api/theme called with theme=light + csrf header. | Devtools timeline + cookies + network. |
| T5-TR2 | rule | Click again on same (already selected) button → no duplicate POST / class change. | Test script counts events. |
| T5-TR3 | rule | Force network offline before clicking → class still changes; cookie still updates; no console error except network warning in POST. | Offline throttling in devtools. |
| T5-TR4 | rule | Inject `data-theme="xss"` → ignored, no class change or POST. | Manual injection. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 6: TinyMCE editor — light/dark skin selection per user theme

**Goal**: Editor pages (/pages/new, /pages/:slug/edit) choose TinyMCE skin +
content_css based on user theme.

### Files
- `views/edit.ejs`
  - Read user theme server-side: `themeForEditor = (user && user.theme === 'dark') ? 'dark' : 'light'`
  - Before loading editor.js, inject an inline JSON snippet:
    `window.__EDITOR_THEME__ = "<%= themeForEditor %>";` or add it into existing WIKI
    script object that already holds csrf + slug.
- `public/js/editor.js`
  - Replace hard-coded:
    ```js
    skin: 'oxide-dark',
    content_css: 'dark'
    ```
    With a ternary:
    ```js
    skin:        (window.__EDITOR_THEME__ === 'dark' || (window.WIKI && window.WIKI.theme === 'dark')) ? 'oxide-dark' : 'oxide',
    content_css: (window.__EDITOR_THEME__ === 'dark' || (window.WIKI && window.WIKI.theme === 'dark')) ? 'dark'        : 'default',
    ```
  - Keep existing image settings, toolbar, plugins intact.

### Dependencies
- Tasks 1 (user.theme populated).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T6-TR1 | rule | Light user visits /pages/new → TinyMCE chrome has light oxide skin, editor content area white/light gray, text dark. No 404 on skin CSS assets. | Network / editor iframe inspection. |
| T6-TR2 | rule | Dark user visits /pages/new → TinyMCE shows oxide-dark + dark content_css (same as current pre-feature visual style). | Compare screenshots with old behaviour. |
| T6-TR3 | rule | Switch user from light → dark via topbar switch, then navigate (server-rendered) to a page editor → editor loads dark skin without browser refresh. | Navigation + editor inspection. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 7: Profile page — theme preferences UI (in POST /profile)

**Goal**: `/profile` page shows a 2-option radio Light / Dark under a new
Preferences heading.  Clicking Save changes on profile form persists the theme,
sets theme cookie, applies instantly on redirect.

### Files
- `views/profile.ejs`
  - Inside the existing POST /profile form, under the Email / Account groups,
    add a new form group labeled Preferences:
    ```html
    <div class="form-group">
      <label class="form-label">Theme</label>
      <div class="radio-row" role="radiogroup" aria-label="Theme preference">
        <label class="radio-card">
          <input type="radio" name="theme" value="light" <%= user.theme==='light' || !user.theme ? 'checked' : '' %>>
          <div class="radio-card-preview radio-card-preview-light"></div>
          <span>Light</span>
        </label>
        <label class="radio-card">
          <input type="radio" name="theme" value="dark" <%= user.theme==='dark' ? 'checked' : '' %>>
          <div class="radio-card-preview radio-card-preview-dark"></div>
          <span>Dark</span>
        </label>
      </div>
      <p class="form-hint">Applied across all devices when you sign into your account.</p>
    </div>
    ```
  - Add 12 lines of inline styles for `.radio-row`, `.radio-card`, `.radio-card-preview-light/dark`
    visual boxes (swatches) so users can see a small preview of the theme before selecting.
- `server.js` `POST /profile` handler (line 2561):
  - Read `theme = coerceTheme(req.body.theme || '')`;
  - Add to `_updateCurrentUserRecord` mutate fn: `rec.theme = theme;`
  - Add to auditLogger info: `themeChanged: displayName + ' theme: ' + old + ' → ' + theme`
  - On successful redirect response: set the same `theme` cookie (MaxAge 30d, non-HttpOnly,
    SameSite Lax, Path=/) so inline FOUC script picks it up before the next page paint.

### Dependencies
- Tasks 1 (coerceTheme), 4 (visual swatches variables exist).

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T7-TR1 | rule | GET /profile shows radio group; correct option checked for user theme. | DOM snapshot. |
| T7-TR2 | rule | Select Dark + Save changes → users.json updated; redirect page paints dark theme immediately; cookie `theme=dark` set. | File + network + visual. |
| T7-TR3 | rule | Send a POST /profile with `theme="nonexistent"` → coerced to light on server; saved as light. | Field + visual verify. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 8: Login page (unauthenticated) — default-light visual + cookie read for FOUC only

**Goal**: No authenticated user context on `/login`; the page still uses the default
light theme tokens (because the server render provides no user.theme; layout.ejs
defaults to `light` when user is missing).  If the browser has a `theme=dark` cookie
from a previous session on the same device, the inline FOUC script will flip it to
dark theme (visual only).  Once logged in, user record wins again.

**Note**: This is low-priority and may be a no-code task as the layout already
defaults light; only verify behaviour.

### Files
- Potentially none — verify existing logic handles unauthenticated case correctly.

### Test Requirements
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T8-TR1 | rule | GET /login (no session, no theme cookie) → renders light theme correctly. | Visual + html.class. |
| T8-TR2 | rule | Set `theme=dark` cookie (no session) → login page renders dark theme (from cookie). | Devtools Application cookie + visual. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task 9: End-to-end cross-cutting tests (human or harness)

Run once all tasks are done.  Evidence collected as final AC acceptance.

### Files tested
- All files above.

### Test Requirements (full spec.md AC coverage)
| TR-ID | Type | Statement | Evidence |
|---|---|---|---|
| T9-TR1 | rule | Full AC-3: create new user "newuser" → default light; switch theme → dark → logout → different browser → login → dark theme still visible. users.json newuser.theme is dark. | Browser test + file inspection. |
| T9-TR2 | rule | Full AC-1: attempt to POST theme:"midnight" to /api/theme → server coerces to light; nothing saved except light; UI renders light. | csrf POST harness test. |
| T9-TR3 | rule | Full AC-10 FOUC: hard-refresh a persisted-light page → no visible dark flash before paint. Hard-refresh persisted-dark → no light flash. Use Devtools performance capture. | Timeline screenshots. |
| T9-TR4 | rubric | NFR-2 toggle latency (top-bar switch). Pass ≥ 1. | Performance trace. |
| T9-TR5 | rule | NFR-4 no regression: re-run `test_duplicate_save.js` 14/14 pass. | node test harness output. |
| T9-TR6 | rule | NFR-4 no regression: create/edit page workflow saves content correctly with both light and dark TinyMCE editor skins. | Manual content save + render. |
| T9-TR7 | rule | Full AC-9 env-admin works: switch theme via topbar → saved in users.json; profile page reflects it. | Env admin manual test. |

### Status: pending
### Completion Evidence: _(filled during Implement)_

---

## Task Status Summary

| Task | AC Coverage | Status |
|---|---|---|
| 1 | AC-1, AC-2, AC-9 | pending |
| 2 | AC-1, AC-3, AC-4, AC-12, AC-3 (persist) | pending |
| 3 | AC-4, AC-5, AC-10 | pending |
| 4 | AC-6, NFR-2 | pending |
| 5 | AC-4, AC-5, NFR-3 | pending |
| 6 | AC-7 | pending |
| 7 | AC-8, AC-1 | pending |
| 8 | AC-10 (unauthenticated default) | pending |
| 9 | ALL AC cross-cutting | pending |
