/**
 * app.js — shared client-side logic
 *  • Sidebar tree: expand/collapse with sessionStorage persistence
 *  • Auto-expand ancestors of the current page
 *  • Sidebar search (filters tree nodes)
 *  • Mobile sidebar toggle
 *  • Flash auto-dismiss
 */
(function () {
  'use strict';

  // ── Determine current page slug from URL ──────────────────────────────────
  const currentSlug = (window.location.pathname.match(/^\/pages\/([^/]+)/) || [])[1] || '';

  // ── Sidebar toggle (mobile) ───────────────────────────────────────────────
  const sidebar       = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const overlay       = document.getElementById('sidebarOverlay');

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    overlay && overlay.classList.add('visible');
    sidebarToggle && sidebarToggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    overlay && overlay.classList.remove('visible');
    sidebarToggle && sidebarToggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  if (sidebarToggle) sidebarToggle.addEventListener('click', () =>
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
  if (overlay) overlay.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) closeSidebar();
  });

  // ── Tree helpers ──────────────────────────────────────────────────────────

  /**
   * Return all immediate child tree-node elements of a parent slug.
   * A child element is one whose data-parent equals parentSlug.
   */
  function getChildNodes(parentSlug) {
    return Array.from(document.querySelectorAll(
      `.tree-node[data-parent="${CSS.escape(parentSlug)}"]`
    ));
  }

  /**
   * Expand (show) all direct children of parentSlug without recursion.
   * Recursion happens lazily when the user clicks further.
   */
  function expandNode(slug) {
    getChildNodes(slug).forEach(n => { n.style.display = ''; });
    const btn = document.querySelector(`.tree-toggle-btn[data-slug="${CSS.escape(slug)}"]`);
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Collapse ' + (btn.closest('.tree-node')?.querySelector('.tree-link-text')?.textContent || ''));
    }
    sessionStorage.setItem('tree_expanded_' + slug, '1');
  }

  function collapseNode(slug) {
    // Hide all descendants recursively
    const collapseAll = s => {
      getChildNodes(s).forEach(n => {
        n.style.display = 'none';
        const childSlug = n.dataset.slug;
        collapseAll(childSlug);
        // Reset their toggle buttons
        const childBtn = n.querySelector('.tree-toggle-btn');
        if (childBtn) childBtn.setAttribute('aria-expanded', 'false');
        sessionStorage.removeItem('tree_expanded_' + childSlug);
      });
    };
    collapseAll(slug);
    const btn = document.querySelector(`.tree-toggle-btn[data-slug="${CSS.escape(slug)}"]`);
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Expand ' + (btn.closest('.tree-node')?.querySelector('.tree-link-text')?.textContent || ''));
    }
    sessionStorage.removeItem('tree_expanded_' + slug);
  }

  // ── Attach toggle button handlers ─────────────────────────────────────────
  document.querySelectorAll('.tree-toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const slug = btn.dataset.slug;
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      isExpanded ? collapseNode(slug) : expandNode(slug);
    });
  });

  // ── Mark active page ──────────────────────────────────────────────────────
  if (currentSlug) {
    const activeNode = document.querySelector(`.tree-node[data-slug="${CSS.escape(currentSlug)}"]`);
    if (activeNode) {
      const row  = activeNode.querySelector('.tree-node-row');
      const link = activeNode.querySelector('.tree-link');
      if (row)  row.classList.add('active');
      if (link) link.classList.add('active-page');
    }
  }

  // ── Auto-expand ancestors of current page ─────────────────────────────────
  function getAncestorSlugs(slug) {
    const ancestors = [];
    let current = document.querySelector(`.tree-node[data-slug="${CSS.escape(slug)}"]`);
    while (current) {
      const parentSlug = current.dataset.parent;
      if (!parentSlug) break;
      ancestors.unshift(parentSlug);
      current = document.querySelector(`.tree-node[data-slug="${CSS.escape(parentSlug)}"]`);
    }
    return ancestors;
  }

  if (currentSlug) {
    getAncestorSlugs(currentSlug).forEach(slug => expandNode(slug));
    // Also make the current page itself visible (in case it's not a root)
    const activeNode = document.querySelector(`.tree-node[data-slug="${CSS.escape(currentSlug)}"]`);
    if (activeNode) activeNode.style.display = '';
  }

  // ── Restore sessionStorage expand state ───────────────────────────────────
  // (for non-page views — e.g. uploads page — restore whatever was expanded)
  document.querySelectorAll('.tree-toggle-btn').forEach(btn => {
    const slug = btn.dataset.slug;
    if (sessionStorage.getItem('tree_expanded_' + slug) === '1') {
      expandNode(slug);
    }
  });

  // ── Sidebar tree filter (title + tags ONLY — no body content full-text) ──
  // Full-text search across page content lives in the Home page search bar.
  // This sidebar filter is a quick title/tags filter so users can narrow the
  // tree down to pages whose VISIBLE labels (title or tag chips) actually
  // contain the typed text — no "mystery matches" from invisible body text.
  const sidebarSearch = document.getElementById('sidebarSearch');
  if (sidebarSearch) {
    let   debounceT = null;

    function clearTitleHighlights() {
      document.querySelectorAll('.tree-link-text').forEach(el => {
        // <mark> may have been injected — restore original text
        const orig = el.dataset.originalTitle;
        if (typeof orig === 'string') {
          el.textContent = orig;
        }
        el.removeAttribute('data-original-title');
      });
      document.querySelectorAll('.tree-match-badge').forEach(el => el.remove());
    }

    function highlightTitleMatch(el, q) {
      if (!q) return;
      const text  = el.textContent || '';
      const low   = text.toLowerCase();
      const idx   = low.indexOf(q);
      if (idx < 0) return false;
      // Preserve original so repeated filter/restore cycles don't stack
      if (typeof el.dataset.originalTitle !== 'string') {
        el.dataset.originalTitle = text;
      }
      const before = text.slice(0, idx);
      const match  = text.slice(idx, idx + q.length);
      const after  = text.slice(idx + q.length);
      // Use innerHTML-safe constituents: mark element highlights match
      el.innerHTML =
        escapeHtml(before) + '<mark class="search-highlight">' +
        escapeHtml(match) + '</mark>' + escapeHtml(after);
      return true;
    }

    function restoreTreeToDefault() {
      clearTimeout(debounceT);
      clearTitleHighlights();
      document.querySelectorAll('.tree-node').forEach(n => {
        n.style.display = n.dataset.depth === '0' ? '' : 'none';
      });
      document.querySelectorAll('.tree-toggle-btn').forEach(btn => {
          if (sessionStorage.getItem('tree_expanded_' + btn.dataset.slug) === '1') {
            expandNode(btn.dataset.slug);
          }
        });
        if (currentSlug) {
          getAncestorSlugs(currentSlug).forEach(s => expandNode(s));
          const an = document.querySelector(`.tree-node[data-slug="${CSS.escape(currentSlug)}"]`);
          if (an) an.style.display = '';
        }
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function filterByUnionSet(matchSlugs, q) {
      const allNodes = Array.from(document.querySelectorAll('.tree-node'));
      // Build set of slugs to show: every match + its full ancestor chain
      const withAncestors = new Set(matchSlugs);
      allNodes.forEach(n => {
        if (!matchSlugs.has(n.dataset.slug)) return;
        let cur = n;
        while (cur) {
          const pSlug = cur.dataset.parent;
          if (!pSlug) break;
          withAncestors.add(pSlug);
          cur = document.querySelector(`.tree-node[data-slug="${CSS.escape(pSlug)}"]`);
        }
      });

      clearTitleHighlights();

      // Apply visibility + highlight + visual expand-state consistency
      allNodes.forEach(n => {
        const isMatch = matchSlugs.has(n.dataset.slug);
        const showIt  = withAncestors.has(n.dataset.slug);
        n.style.display = showIt ? '' : 'none';

        // If this is a matched leaf, wrap the match in the title
        if (isMatch) {
          const titleEl = n.querySelector('.tree-link-text');
          const linkEl  = n.querySelector('.tree-link');
          const tagsStr = (linkEl?.dataset.tags || '').toLowerCase();
          const titleHit = q && titleEl && (titleEl.textContent || '').toLowerCase().includes(q);
          const tagsHit  = q && tagsStr.includes(q);
          if (titleHit) highlightTitleMatch(titleEl, q);
          // Badge if match came from tags (not title — shows user why the page is present
          if (tagsHit && !titleHit) {
            const row = n.querySelector('.tree-node-row');
            if (row && !row.querySelector('.tree-match-badge')) {
              const badge = document.createElement('span');
              badge.className = 'tree-match-badge';
              badge.textContent = 'tag';
              badge.title = 'Matched by page tag';
              row.appendChild(badge);
            }
          }
        }

        // If this node is an ancestor (not itself a match) that is shown so
        // that a descendant match is visible underneath, flip aria-expanded to
        // visually consistent state even if expandNode normally sets the style.display.
        const ancestorToggleBtn = n.querySelector('.tree-toggle-btn');
        if (ancestorToggleBtn && showIt && !isMatch) {
          const hasMatchUnderneath = Array.from(n.querySelectorAll(':scope > .tree-node-row ~ .tree-node, .tree-node')).some(child =>
            matchSlugs.has(child.dataset.slug)
          );
          // Simpler and more robust: just flip it expanded if the node has any direct children that are visible
          const anyVisibleChild = getChildNodes(n.dataset.slug).some(child =>
            withAncestors.has(child.dataset.slug)
          );
          if (anyVisibleChild) {
            ancestorToggleBtn.setAttribute('aria-expanded', 'true');
          }
        }
      });
    }

    sidebarSearch.addEventListener('input', function () {
      const rawQ = this.value;
      const q    = rawQ.toLowerCase().trim();
      clearTimeout(debounceT);

      if (!q) {
        restoreTreeToDefault();
        return;
      }

      // Collect matches: title (data-search-term on <a class=tree-link>) + tags (data-tags on same link)
      const matchSlugs = new Set();
      Array.from(document.querySelectorAll('.tree-node')).forEach(n => {
        const link = n.querySelector('.tree-link');
        if (!link) return;
        const titleTerm = link.dataset.searchTerm || '';
        const tagsTerm  = (link.dataset.tags || '').toLowerCase();
        if (titleTerm.includes(q) || tagsTerm.includes(q)) {
          matchSlugs.add(n.dataset.slug);
        }
      });
      filterByUnionSet(matchSlugs, q);
    });

    // Also clear filter state if user navigates (browser back/forward)
    window.addEventListener('pageshow', () => {
      if (!sidebarSearch.value) restoreTreeToDefault();
    });
  }

  // ── Auto-dismiss flash messages after 6 s ────────────────────────────────
  document.querySelectorAll('.flash').forEach(el => {
    const closeBtn = el.querySelector('.flash-close');
    if (closeBtn) closeBtn.addEventListener('click', () => el.remove());
    setTimeout(() => {
      el.style.transition = 'opacity 0.4s ease';
      el.style.opacity    = '0';
      setTimeout(() => el.remove(), 400);
    }, 6000);
  });

  // ── Session idle-timeout monitor + warning modal ─────────────────────────
  // (Option C from spec: short cookie TTL (rolling:true) + client-side idle
  //  warning modal + activity-driven auto-expiry + keepalive endpoint.)
  //
  // Lifecycle:
  //   page load         → compute next_warn_ts = lastActivityMs + (idle - warn)*1000
  //                       compute next_expire_ts = lastActivityMs + idle*1000
  //   user input events   → reset lastActivityTs → hide modal if open
  //   tick (every 250ms) →  if NOW >= next_warn_ts → show modal + countdown tick
  //                         if NOW >= next_expire_ts → POST /logout?reason=inactive
  //   [Extend session] → GET /api/session/keepalive → reset timestamps
  //   [Log out now]  → POST /logout (manual)
  (function installIdleMonitor() {
    const scriptTag = document.getElementById('wikiConfig');
    let cfg = null;
    try { if (scriptTag && scriptTag.textContent) cfg = JSON.parse(scriptTag.textContent); } catch { cfg = null; }
    if (!cfg || !cfg.idleSecs || !cfg.warnSecs || cfg.idleSecs <= cfg.warnSecs) return;
    const IDLE_MS = cfg.idleSecs * 1000;
    const WARN_MS = cfg.warnSecs * 1000;
    const WARN_AT_MS = IDLE_MS - WARN_MS;
    const KEEPALIVE_URL = cfg.keepaliveUrl || '/api/session/keepalive';
    const LOGOUT_URL    = cfg.logoutUrl    || '/logout';
    const LOGIN_URL     = cfg.loginUrl     || '/login';
    const TICK_MS = 250;

    const modal      = document.getElementById('idleWarningModal');
    const countdownNum = document.getElementById('idleCountdownNum');
    const extendBtn = document.getElementById('idleExtendBtn');
    const logoutBtn = document.getElementById('idleLogoutBtn');
    if (!modal || !countdownNum || !extendBtn || !logoutBtn) return;

    let lastActivityTs = Date.now();
    let warnShown = false;
    let expiredFired = false;
    let keepaliveInFlight = false;
    // Debounce activity events so a single keydown doesn't dispatch zillion times.
    function resetIdle() { lastActivityTs = Date.now(); if (warnShown) hideModal(); expiredFired = false; }

    const onActivity = (function () {
      let pending = false;
      return function _onActivity() {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; resetIdle(); }, 60);
      };
    })();

    // Activity events that count as "user is present and working".
    ['keydown','mousedown','mousemove','wheel','touchstart','touchmove','scroll','pointerdown',
     'keypress','input','click','contextmenu','dragstart','keyup'
    ].forEach(ev => window.addEventListener(ev, onActivity, { passive: true, capture: false }));
    // Also: any successful fetch through keepalive counts as "activity" implicitly via resetIdle().

    function showModal() {
      warnShown = true;
      modal.classList.remove('hidden');
      modal.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
      try { extendBtn.focus(); } catch {}
      // Accessibility: close with Escape key
    }
    function hideModal() {
      warnShown = false;
      modal.classList.add('hidden');
      modal.setAttribute('hidden', '');
      document.body.style.overflow = '';
    }

    function buildCsrfToken() {
      // Prefer meta, fall back to the topbar logout form (always rendered for any authed user).
      const m = document.querySelector('meta[name="csrf-token"]');
      if (m && m.content) return m.content;
      const f = document.querySelector('#logoutBtn')?.closest('form');
      const inp = f ? f.querySelector('input[name="_csrf"]') : null;
      return inp ? inp.value : '';
    }

    function doLogout(reason) {
      // Build a transient <form> → POST so we send _csrf and navigate cleanly.
      const f = document.createElement('form');
      f.method = 'POST';
      const target = LOGOUT_URL + (reason === 'inactive' ? '?reason=inactive' : '');
      f.action = target;
      const tok = buildCsrfToken();
      if (tok) {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = '_csrf'; i.value = tok; f.appendChild(i);
      }
      document.body.appendChild(f);
      f.submit();
    }

    extendBtn.addEventListener('click', async function () {
      if (keepaliveInFlight) return;
      keepaliveInFlight = true;
      try {
        const r = await fetch(KEEPALIVE_URL, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok || r.status === 204) { resetIdle(); }
        else if (r.status === 401) { /* session already dead, go to login */
          window.location.href = LOGIN_URL + '?reason=inactive';
        } else {
          // Unknown keepalive failure: optimistic reset anyway (next tick will force-logout if really over
          resetIdle();
        }
      } catch {
        resetIdle();
      } finally { keepaliveInFlight = false; }
    });
    logoutBtn.addEventListener('click', () => doLogout('manual'));
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') doLogout('manual'); });

    function tick() {
      if (expiredFired) return;
      const now = Date.now();
      const remainingMs = (lastActivityTs + IDLE_MS) - now;
      if (remainingMs <= 0) {
        expiredFired = true;
        doLogout('inactive');
        return;
      }
      if (!warnShown && now - lastActivityTs >= WARN_AT_MS) showModal();
      if (warnShown) {
        const secs = Math.max(0, Math.ceil(remainingMs / 1000));
        if (String(countdownNum.textContent) !== String(secs)) countdownNum.textContent = String(secs);
        // Urgent color if < 30 s left: bump countdown ring animation
        countdownNum.style.color = secs <= 30 ? 'var(--c-danger)' : '';
      }
    }
    // Escape also hides modal and clears modal and keydown activity will reset too so no-op but also:
    setInterval(tick, TICK_MS);
    tick();
  })();

})();
