# Page / Child Reordering Implementation Plan

## Repository Research

### What already works (no code change needed)
- **Page schema & storage**: Every page record already carries a `position: number` field, persisted to `data/pages/<slug>.json`. New pages are appended `position = siblings.length` → they land at the end of their sibling group ([server.js:1096–1103](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L1096-L1103)).
- **Sorting everywhere uses position then title**: `buildTree()` ([server.js:484](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L484)), page-view children + siblings ([server.js:1136–1139](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L1136-L1139)), and the sibling-normalisation inside the move endpoint ([server.js:1260–1263](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L1260-L1263)) all sort by `(position ?? 9999)` then `title.localeCompare`.
- **Raw-position editing on edit form**: `edit.ejs` Hierarchy widget already exposes a `position` number input ([edit.ejs:136–141](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/views/edit.ejs#L136-L141)) — saved by `server.js:1221`.
- **Up/down swap endpoint**: `POST /pages/:slug/move` already exists, is gated with `ensureRole('editor')`, normalises positions to `0..n-1`, then swaps `position` with the neighbour at `idx ± 1` ([server.js:1251–1278](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js#L1251-L1278)).
- **Page-view header buttons already wired**: `page.ejs` header row (current page's own up/down among siblings) renders correctly if `canMoveUp / canMoveDown` are set — they are passed from the `GET /pages/:slug` handler.

### What is missing (what the user is asking for)
1. **"In This Section" children on page view**: Each child card (`.children-grid .child-card`) is currently a clickable `<a>` with no affordance to reorder that child relative to its siblings. Editors need ↑↓ buttons per child row.
2. **Home page tree**: Top-level section cards (`home.ejs` `.section-grid .section-card`) and their nested `.section-card-children` list items carry no reorder controls. Editors can only reorder via the edit page or by navigating *into* the page — not from the home view.
3. **Return-to-viewer UX after move**: `POST /pages/:slug/move` currently always redirects to `/pages/:slug` — fine when moving the current page itself, but if the user presses ↑↓ on a *child* while sitting on the parent page (or on a home card), they are redirected away. Need a `redirect` override so context is preserved.

### Access control (unchanged)
- All reorder mutations must stay behind `ensureRole('editor')`. The existing `/move` endpoint already is; new UI buttons must be guarded by the same `canEdit` flag used elsewhere in the templates. Readers see no change.

## Files and Modules

| File | Change |
|---|---|
| [server.js](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js) | (A) `POST /pages/:slug/move`: accept optional `redirect` body param → after save, `res.redirect(redirect)` iff redirect is same-origin (starts with `/`). Fall back to the current behaviour. |
| [server.js](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js) | (B) `GET /pages/:slug`: enrich each entry in `children` array returned to template with `_canMoveUp: bool, _canMoveDown: bool` computed by indexing into the sorted siblings for each child's parent (its parent is the current page, so the children array *is* the sorted siblings list — enrichment is simply `idx > 0` and `idx < len-1`). |
| [server.js](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/server.js) | (C) Root handler `GET /` (home): after building `tree`, do a single depth-1 pre-order pass to annotate every node with `_canMoveUp` and `_canMoveDown` relative to its sibling list at that level of the tree. Pass the enriched tree to `views/home.ejs`. |
| [views/page.ejs](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/views/page.ejs) | In "In This Section" `children-grid` (lines 106–131): convert each card from a bare `<a>` into a layout wrapper with the link + an editor-only button cluster (↑↓ + delete-page). Each button submits a tiny POST form to `/pages/:childSlug/move` with `direction` + `redirect=/pages/${page.slug}` (return to parent). Guard entire cluster with the existing `canEdit` boolean. |
| [views/home.ejs](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/views/home.ejs) | Two places: (1) top-level `.section-card` — add small editor-only ↑↓ cluster to `.section-card-footer` alongside existing "Open" / "Add chapter" buttons, redirecting back to `/`. (2) `.section-card-children` `<li>` rows — same ↑↓ cluster on each list item for depth-1 sub pages. Guard with `canEdit`. |
| [public/css/style.css](file:///c:/Users/leeda/OneDrive/Dev/Trae/OnlineWiki/public/css/style.css) | New utility classes for inline move controls: `.child-card-actions` (inside children cards), `.card-reorder-cluster` / `.btn-reorder` (home cards + li rows). Keep buttons tiny (24–28 px square, icon-only), ensure they don't add height or break existing hover states / focus rings. |

## Implementation Steps (dependency order)

1. **server.js — move-endpoint redirect safety (lowest level, must be done before UI forms that use it)**.
   - In `POST /pages/:slug/move`:
     - Read `const redirectTo = (typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/') && !req.body.redirect.startsWith('//')) ? req.body.redirect : null;`
     - After existing logic, change final line: `res.redirect(redirectTo || \`/pages/${req.params.slug}\`);`
     - Start-of-string `/` check prevents open-redirects. No query param; only body form field (matches CSRF form POST pattern used everywhere else).

2. **server.js — enrich page-view children with move flags**.
   - In `GET /pages/:slug`, after `const children = treeNode ? treeNode.children : [];` (line 1131), add:
     ```js
     const annotatedChildren = children.map((c, i, arr) =>
       ({ ...c, _canMoveUp: i > 0, _canMoveDown: i >= 0 && i < arr.length - 1 }));
     ```
   - Pass `annotatedChildren` to `res.render(...)` under the name `children` (replace current `children` variable). This keeps templates unchanged. `_canMoveUp/Down` are non-enumerable-underscore prefixed so they don't conflict with real page fields.

3. **server.js — enrich home tree (depth 1) with move flags for each sibling list**.
   - Locate the root `GET /` handler (near user uploads/admin routes). Find the call that does `res.render('home', { tree, pages, ... })` or computes the tree from `buildTree(listPages())`.
   - Right before render, walk the tree and all immediate children:
     ```js
     function annotateSiblings(list) {
       list.forEach((n, i, arr) => {
         n._canMoveUp   = i > 0;
         n._canMoveDown = i < arr.length - 1;
         if (Array.isArray(n.children) && n.children.length) annotateSiblings(n.children);
       });
     }
     annotateSiblings(tree);
     ```
   - This is safe because:
     - `buildTree()` returns fresh objects spread via `{ ...p, children: [] }` (line 477), so mutating the returned tree doesn't affect the original pages list.
     - We only ever annotate up to depth 2, matching what home.ejs actually renders (root section cards + 6-preview first-level children).

4. **views/page.ejs — In This Section per-child reorder controls**.
   - Restructure `children-grid` rows: wrap the current `<a class="child-card">` in a `<div class="child-card-wrap">`.
   - Append a sibling `<div class="child-card-actions">` after the `<a>` — visible iff `canEdit`.
   - Inside actions, two small POST forms for ↑↓ (disabled/hidden when the child's `_canMoveUp/Down` are false):
     - `action=/pages/<%= child.slug %>/move`
     - hidden `_csrf`
     - hidden `direction=up` / `direction=down`
     - hidden `redirect=/pages/<%= page.slug %>#childrenHeading` (anchored to the section so user lands where they clicked).
     - Buttons: 24 px square, `btn btn-xs btn-ghost btn-reorder`, aria-labels "Move child {title} up/down".
   - Keep the existing card body / tags / meta / arrow unchanged.

5. **views/home.ejs — two reorder UIs**.
   - (A) Top-level section cards: inside `.section-card-footer` (after `Open →` / `Add chapter`), render a `.card-reorder-cluster` of two POST forms **only when `canEdit` is true**.
     - same pattern: `action=/pages/<%= section.slug %>/move`, `_csrf`, `direction`, `redirect=/?s=<%= encodeURIComponent(section.slug) %>#sec_<%= section.slug %>` for anchoring.
     - Only show ↑ when `section._canMoveUp` is true. Show ↓ when `section._canMoveDown`.
   - (B) Inside `.section-card-children` each `<li>`: currently the whole `<li>` is the `<a class="section-child-link">`. Instead, keep the `<a>` but add a small inline `<span class="child-row-actions">` **after the link inside the li**; wrap the whole li content in flex. Buttons same as above, but `redirect=/` (no anchor needed on small list).

6. **public/css/style.css — small affordance styles**.
   - `.child-card-wrap`: `position: relative;` so the actions pill can sit on the card without breaking the link hover.
   - `.child-card-actions`: `position: absolute; top: 0.5rem; right: 0.5rem; display: inline-flex; gap: 0.2rem; z-index: 2; background: rgba(0,0,0,0.25); border-radius: var(--r); padding: 0.15rem; opacity: 0; transition: opacity var(--t);`. `.child-card:hover .child-card-actions, .child-card-wrap:focus-within .child-card-actions` → `opacity: 1`. Pattern keeps cards clean until hover/focus.
   - `.btn-reorder`: `min-width: 24px; min-height: 24px; width: 24px; height: 24px; padding: 0; border-radius: calc(var(--r) - 2px); display: inline-flex; align-items: center; justify-content: center; svg { width: 13px; height: 13px; } }`
   - `.card-reorder-cluster` (home card footer): `display: inline-flex; gap: 0.25rem; align-items: center;`
   - `.section-card-children li`: `display: flex; align-items: center; justify-content: space-between; gap: 0.4rem;` + `.child-row-actions` same button sizes.

## Dependencies and Considerations
- **No new libraries or npm installs needed** — all vanilla HTML forms, existing CSRF flow, existing ensureRole middleware, existing sort.
- **No schema migration** — position field has existed since the start. Any legacy pages with `position: undefined` already fall back to `9999` during sort, and a call to any `/move` endpoint normalises all sibling positions into dense `0..n-1` on the fly. So the first time any editor touches up/down on a sibling group, legacy data is cleaned up automatically.
- **Open-redirect hardening**: only accept `redirect` body values that begin with a single `/` and not `//`. This matches every URL on the site (all routes start `/pages/...`, `/uploads`, `/`) and excludes external (`https://`) and protocol-relative (`//evil.com`) redirects.
- **Anchors for UX**: redirect URLs include `#childrenHeading` / `#sec_slug` where possible, so the page scrolls back to exactly the list the user was editing. This compensates for the whole-page redirect that comes from form POST without AJAX.
- **Reader mode preserved**: every new button / wrapper is wrapped in `<% if (canEdit) { %>` — reader HTML unchanged (no unused markup).
- **Delete vs Move** scope: this plan does NOT introduce per-child delete buttons on page/home views (they exist on the page header). If user wants them, separate change.

## Validation
1. `node --check server.js` → exit 0.
2. EJS compile of `views/page.ejs` and `views/home.ejs` via sandbox `new Function(ejs.compile(...))` → exit 0 each.
3. Manual test checklist (once user can run server):
   - [ ] As editor, on Home: press ↑ on the 2nd section card → card becomes 1st; page stays on Home; other cards reorder.
   - [ ] Press ↑ on the 1st → button disabled/no-op, positions unchanged.
   - [ ] Press ↓ on last section → button disabled/no-op.
   - [ ] As editor, open Parent page with children A B C (in order). On child B, click ↑ → order A C B? No — B swaps with A: order B A C. Land on same parent page, scrolled to In This Section.
   - [ ] Move child B down → order A C B, land same page.
   - [ ] On each child card that's first or last in the list, only one of ↑/↓ is shown.
   - [ ] Navigate sidebar / home view after reorder — sort order respected everywhere (tree, home cards, children grid, breadcrumb).
   - [ ] Log in as reader: no ↑↓ buttons visible anywhere; attempting to hand-craft POST to /pages/x/move returns 403 (existing middleware, confirm).
   - [ ] Regression: page header ↑↓ for the current page still works, redirects to `/pages/slug` (uses new redirect field empty so falls back to legacy).
   - [ ] Regression: `/pages/:slug/edit` `position` number input still overwrites value on save; siblings update on next re-read (server normalizes on next move).

## Risks
- **Risk: Tree mutation in GET /**. → Mitigation: `buildTree` spreads (`{ ...p, children: [] }`) so returned objects are shallow-cloned. Annotate function only sets `_canMoveUp/_canMoveDown`, which never conflict with real page fields (they start with `_`). Tested in the enrichment style used for children in step 2.
- **Risk: Absolute-positioned child-card actions sit on top of clickable link`. → Mitigation: button forms use `z-index: 2`; but since the actions are outside the `<a>` (sibling, not descendant), they can't absorb the link click. The `<a>` still fills the whole card inside wrap; buttons overlay a tiny corner only, form POSTs, don't bubble click to `<a>`.
- **Risk: POST after scroll loses list context**. → Mitigation: include anchor in `redirect` field; server echoes it back in the 302 Location. Modern browsers scroll to it.
- **Risk: Readers bypass UI to hit endpoint**. → Mitigation: endpoint has `ensureRole('editor')` and always did. Verified in prior route audit. Adding redirect param is server-side only so no new auth surface.
