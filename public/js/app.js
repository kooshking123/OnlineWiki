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

  // ── Sidebar tree search ───────────────────────────────────────────────────
  const sidebarSearch = document.getElementById('sidebarSearch');
  if (sidebarSearch) {
    let   debounceT = null;
    let   reqToken  = 0;

    function restoreTreeToDefault() {
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

    function filterByUnionSet(matchSlugs) {
      const allNodes = Array.from(document.querySelectorAll('.tree-node'));
      // Ensure every matched slug has all its ancestors visible too
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
      allNodes.forEach(n => {
        n.style.display = withAncestors.has(n.dataset.slug) ? '' : 'none';
      });
    }

    sidebarSearch.addEventListener('input', function () {
      const q = this.value.toLowerCase().trim();
      clearTimeout(debounceT);

      if (!q) {
        restoreTreeToDefault();
        return;
      }

      // Pass 1: fast local title matches (visible immediately, no network wait)
      const titleMatchSlugs = new Set();
      Array.from(document.querySelectorAll('.tree-node')).forEach(n => {
        const link = n.querySelector('.tree-link');
        const term = link ? (link.dataset.searchTerm || '') : '';
        if (term.includes(q)) titleMatchSlugs.add(n.dataset.slug);
      });
      filterByUnionSet(titleMatchSlugs);

      // Pass 2: server-backed full-text (content, tags, slugs) — async
      const myToken = ++reqToken;
      debounceT = setTimeout(() => {
        fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            if (myToken !== reqToken) return;
            const union = new Set(titleMatchSlugs);
            if (data && Array.isArray(data.results)) {
              data.results.forEach(r => { if (r.slug) union.add(r.slug); });
            }
            filterByUnionSet(union);
          })
          .catch(err => {
            if (myToken !== reqToken) return;
            console.warn('[sidebar-search]', err);
          });
      }, 200);
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

})();
