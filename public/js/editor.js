/**
 * editor.js — TinyMCE initialisation + slug auto-generation + attachment picker
 * Loaded only on the edit/create page. Requires window.WIKI to be set by the
 * inline <script> in edit.ejs before this file loads.
 */
(function () {
  'use strict';

  const WIKI = window.WIKI || { isNew: true, slug: '', content: '' };
  const IS_DARK = (window.__EDITOR_THEME__ === 'dark');

  // ── TinyMCE ─────────────────────────────────────────────────────────────
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

  // Current pending file_picker_callback resolver: null or { cb, meta, type }
  let pendingPicker = null;

  tinymce.init({
    selector:    '#content',
    height:      560,
    min_height:  400,
    resize:      true,
    menubar:     'file edit view insert format tools table help',
    plugins: [
      'advlist', 'autolink', 'lists', 'link', 'charmap',
      'anchor', 'searchreplace', 'visualblocks', 'code',
      'fullscreen', 'insertdatetime', 'table', 'help',
      'wordcount', 'codesample', 'emoticons', 'preview',
      'image'
    ],
    toolbar_persist: true,
    toolbar_mode: 'wrap',
    toolbar_location: 'top',
    toolbar:
      'undo redo | blocks | ' +
      'bold italic underline strikethrough | forecolor backcolor | ' +
      'link image | alignleft aligncenter alignright alignjustify | ' +
      'bullist numlist outdent indent | ' +
      'table | codesample | blockquote hr | ' +
      'searchreplace | fullscreen | preview | code | help',
    skin:        (window.__EDITOR_THEME__ === 'dark') ? 'oxide-dark' : 'oxide',
    content_css: (window.__EDITOR_THEME__ === 'dark') ? 'dark'        : 'default',
    image_title: true,
    automatic_uploads: true,
    paste_data_images: true,
    image_advtab: true,
    image_caption: true,
    image_prepend_url: false,
    image_class_list: null,
    image_uploadtab: true,
    // TinyMCE 7.9: image_resize removed/deprecated; replaced by object_resizing
    // plus resize_img_proportional. Object resizing must be a comma-separated
    // string-list of selector tokens (not boolean) to enable image handles.
    // image_resize kept for TinyMCE 6.x compat; real work is done by line below.
    image_resize: true,
    object_resizing:       'table,img,figure.image,div,video,iframe',
    resize_img_proportional: true,
    // Keep server-absolute paths /uploads/…, /avatars/…, /pages/… untouched so
    // they resolve identically from /pages/:slug, /pages/:slug/edit and /pages/new.
    // Don't let TinyMCE rewrite them to document-relative.
    relative_urls:       false,
    remove_script_host:  false,
    document_base_url:   (typeof location !== 'undefined' ? location.origin : '') + '/',
    convert_urls:        false,
    editable_class: 'mceEditable',
    // Server-side endpoint that receives { slug, data: base64, mime, filename }
    // and returns { location: '/uploads/123_filename.png' }.
    images_upload_handler: async function (blobInfo, progress) {
      // Build a JSON body with the base64 payload + WIKI CSRF check via header.
      // We upload to /pages/:slug/image-upload so role checks + audit logging
      // are consistent with other page-mutating routes.
      const uploadSlug = WIKI.slug || '_new_page_placeholder_';
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image file.'));
        reader.onload = () => {
          const mime = blobInfo.blob().type || 'image/png';
          const ext  = mimeToExt(mime);
          const rawBase64 = typeof reader.result === 'string' ? reader.result.split(',')[1] : null;
          if (!rawBase64) return reject(new Error('Image could not be converted to base64.'));
          fetch(`/pages/${encodeURIComponent(uploadSlug)}/image-upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': WIKI.csrf
            },
            body: JSON.stringify({
              filename: blobInfo.filename() || ('pasted-image-' + Date.now() + ext),
              mime,
              data: rawBase64
            })
          }).then(async r => {
            const text = await r.text();
            let j = {};
            try { j = JSON.parse(text); } catch { /* ignore */ }
            if (!r.ok) return reject(new Error(j.error || 'Upload failed (' + r.status + ')'));
            if (!j.location) return reject(new Error('Server did not return image location.'));
            resolve(j.location);
          }).catch(err => reject(err));
        };
        reader.readAsDataURL(blobInfo.blob());
      });
    },
    // Custom file picker — reuse the attachments modal for image/link insertion
    file_picker_types: 'image file',
    file_picker_callback: function (cb, value, meta) {
      pendingPicker = { cb, meta };
      openAttachPicker(/* fromTinyMCE */ true, meta.filetype);
    },
    // Match wiki typography
    content_style: `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
      html, body {
        background: ${IS_DARK ? '#0d1117' : '#ffffff'} !important;
      }
      body {
        font-family: 'Inter', sans-serif;
        font-size: 15px;
        line-height: 1.75;
        color: ${IS_DARK ? '#e6edf3' : '#1f2328'};
        background: ${IS_DARK ? '#0d1117' : '#ffffff'};
        padding: 1.25rem 1.5rem;
        max-width: 860px;
        margin: 0 auto;
      }
      ::selection {
        background: ${IS_DARK ? 'rgba(79,148,248,0.28)' : 'rgba(37,99,235,0.18)'};
        color: inherit;
      }
      h1,h2,h3,h4,h5,h6 { font-weight: 700; line-height: 1.3; margin-top: 1.4em; color: inherit; }
      h1 { font-size: 1.9rem; }
      h2 { font-size: 1.45rem; }
      h3 { font-size: 1.2rem; }
      a { color: ${IS_DARK ? '#4f94f8' : '#2563eb'}; }
      code {
        background: ${IS_DARK ? '#21262d' : 'rgba(175,184,193,0.2)'};
        color: ${IS_DARK ? '#e6edf3' : '#1f2328'};
        padding: 0.1em 0.35em;
        border-radius: 4px;
        font-size: 0.88em;
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      pre {
        background: ${IS_DARK ? '#161b22' : '#f6f8fa'};
        border: 1px solid ${IS_DARK ? '#30363d' : '#d0d7de'};
        border-radius: 8px;
        padding: 1rem;
        overflow-x: auto;
        color: inherit;
      }
      pre code {
        background: transparent;
        padding: 0;
        border-radius: 0;
        font-size: 0.9em;
      }
      blockquote {
        border-left: 3px solid ${IS_DARK ? '#4f94f8' : '#2563eb'};
        padding: 0.6rem 1rem;
        margin: 1rem 0;
        background: ${IS_DARK ? 'rgba(31,61,109,0.5)' : 'rgba(37,99,235,0.08)'};
        color: ${IS_DARK ? '#b7bdc7' : '#4a515a'};
        border-radius: 0 8px 8px 0;
      }
      table { border-collapse: collapse; width: 100%; }
      th, td {
        border: 1px solid ${IS_DARK ? '#30363d' : '#d0d7de'};
        padding: 0.5rem 0.75rem;
      }
      th {
        background: ${IS_DARK ? '#21262d' : '#f6f8fa'};
        font-weight: 600;
      }
      tr:nth-child(even) td {
        background: ${IS_DARK ? 'rgba(255,255,255,0.02)' : 'rgba(175,184,193,0.08)'};
      }
      img { max-width: 100%; border-radius: 8px; }
      hr {
        border: none;
        border-top: 1px solid ${IS_DARK ? '#30363d' : '#d0d7de'};
        margin: 2rem 0;
      }
      ul, ol { padding-left: 1.6em; }
      li { margin: 0.2em 0; }
    `,
    // Ensure form textarea is updated on save
    setup(editor) {
      editor.on('init', () => {
        if (WIKI.content) editor.setContent(WIKI.content);
      });
    },
    // Link dialog opens as modal
    link_assume_external_targets: true,
    link_default_target: '_blank',
    // Tables
    table_default_attributes: { border: '0' },
    table_default_styles: { 'border-collapse': 'collapse', 'width': '100%' },
    // Code sample
    codesample_languages: [
      { text: 'HTML/XML', value: 'markup' },
      { text: 'JavaScript', value: 'javascript' },
      { text: 'TypeScript', value: 'typescript' },
      { text: 'CSS', value: 'css' },
      { text: 'Python', value: 'python' },
      { text: 'Java', value: 'java' },
      { text: 'C#', value: 'csharp' },
      { text: 'PHP', value: 'php' },
      { text: 'Ruby', value: 'ruby' },
      { text: 'SQL', value: 'sql' },
      { text: 'Bash', value: 'bash' },
      { text: 'PowerShell', value: 'powershell' },
    ],
    promotion: false   // hide "Upgrade" banner
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Save flow — fully synchronous, 100% blocking confirm, zero async races
  // ──────────────────────────────────────────────────────────────────────────
  //
  // HISTORY (what was broken before this rewrite — all 4 rounds):
  //   • Round 1: guard inside submit event listener — Chromium schedules the
  //     native POST as an async task BEFORE window.confirm() inside the
  //     submit handler returns → page saved before dialog paint.
  //   • Round 2: guard moved to saveBtn click, but commitRealSubmit used
  //     setTimeout(trySubmit, 0) + requestSubmit() → race still possible.
  //   • Round 3: patchCommitRef wrapper added to flip submitOk → true,
  //     but double-guard chain still leaked saves on Cancel (confirmed via
  //     monkey-patch window.confirm returning false → page still saved).
  //   • Round 4 (CURRENT, reproduced): confirm returns false (Cancel) yet
  //     duplicate-title page is successfully written and browser navigates.
  //
  // ROOT CAUSE OF ALL ROUNDS:
  //   Any code path that lets the browser see ANY form-submit machinery
  //   (requestSubmit, .click() on a submitter inside <form>, setTimeout-
  //   deferred .submit(), or even type=submit button + preventDefault)
  //   is vulnerable to Chromium's async form-submission algorithm, which
  //   schedules the real POST in parallel with the blocking confirm()
  //   nested event loop.  POST wins the race → "saved before dialog".
  //
  // THE ONLY RELIABLE FIX:
  //   (a) saveBtn is type="button" (NOT type=submit) — browser cannot infer
  //       a default submit action from it even if preventDefault fails.
  //   (b) commitRealSubmit calls the HTMLFormElement.submit() METHOD directly
  //       — this does NOT fire the 'submit' event listener (HTML spec:
  //       "The submit() method, when invoked, must submit the form element
  //       from the form element itself, with the submitted from submit()
  //       method flag set.").  Zero submit-event → zero double-guard race.
  //   (c) No setTimeouts anywhere.  Everything stays on the same JS call
  //       stack as the click / keypress that initiated save.
  //   (d) window.confirm() is a TRUE blocking call (runs a nested native
  //       message loop); we ONLY invoke the network POST after it returns.
  //
  // TWO MUTUALLY EXCLUSIVE SUBMISSION PATHWAYS, BOTH USING THE SAME GUARD:
  //   Path A (primary, 99% of clicks):  saveBtn (type=button) click handler
  //                                      → guard → form.submit()
  //   Path B (belt-and-suspenders):      Enter-key in a text field triggers
  //                                      the hidden defaultSubmitBtn via
  //                                      form.submit event → guard → prevent
  //                                      → form.submit()
  // ──────────────────────────────────────────────────────────────────────────
  const pageForm         = document.getElementById('pageForm');
  const saveBtn          = document.getElementById('saveBtn');

  function runDuplicateGuardAndMaybeConfirm() {
    var titleInput    = document.getElementById('pageTitle');
    var confirmInput  = document.getElementById('confirmDuplicate');
    if (!titleInput || !confirmInput) return true;

    var selfSlug       = (window.WIKI && window.WIKI.slug) ? window.WIKI.slug : '';
    var originalTitle  = (window.WIKI && window.WIKI.originalTitle ? window.WIKI.originalTitle : '').trim().toLowerCase();
    var existingTitles = (window.WIKI && window.WIKI.existingTitles) ? window.WIKI.existingTitles : [];

    var newTitle      = (titleInput.value || '').trim();
    var newTitleLower = newTitle.toLowerCase();
    var isNewPage     = !window.WIKI || !!window.WIKI.isNew;
    var titleChanged  = isNewPage || (newTitleLower !== originalTitle);

    if (!newTitle || !titleChanged) return true;

    var dup = null;
    for (var i = 0; i < existingTitles.length; i++) {
      var t = existingTitles[i];
      if (!t || !t.title) continue;
      var slugMatch  = t.slug === selfSlug;
      var titleMatch = String(t.title).trim().toLowerCase() === newTitleLower;
      if (titleMatch && !slugMatch) { dup = t; break; }
    }
    if (!dup) return true;
    if (confirmInput.value === 'true') return true;

    var msg = 'Another page titled "' + dup.title +
      '" already exists (slug: /pages/' + dup.slug + ').\n\nSave anyway with a duplicate title?';
    var ok = window.confirm(msg);
    if (ok) confirmInput.value = 'true';
    return ok;
  }

  function commitRealSubmit() {
    tinymce.triggerSave();
    pageForm.submit();
  }

  if (pageForm && saveBtn) {
    saveBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();

      tinymce.triggerSave();

      var guardPassed = false;
      try {
        guardPassed = !!runDuplicateGuardAndMaybeConfirm();
      } catch (_) {
        guardPassed = false;
      }
      if (!guardPassed) return;
      commitRealSubmit();
    });
  }

  if (pageForm) {
    pageForm.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopPropagation();

      tinymce.triggerSave();

      var passed = false;
      try { passed = !!runDuplicateGuardAndMaybeConfirm(); } catch (_) { passed = false; }
      if (!passed) return;
      commitRealSubmit();
    });
  }

  // ── Slug auto-generation (new pages only) ─────────────────────────────────
  const titleInput = document.getElementById('pageTitle');
  const slugInput  = document.getElementById('pageSlug');
  let slugUserEdited = false;

  function toSlug(str) {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  if (titleInput && slugInput && WIKI.isNew) {
    titleInput.addEventListener('input', function () {
      if (!slugUserEdited) slugInput.value = toSlug(this.value);
    });
    slugInput.addEventListener('input', function () {
      slugUserEdited = this.value.length > 0;
      this.value = toSlug(this.value + ' ').trim() + (this.value.endsWith('-') ? '-' : '');
    });
  }

  // ── Attachment picker ─────────────────────────────────────────────────────
  const addAttachmentBtn    = document.getElementById('addAttachmentBtn');
  const mediaInsertLinkBtn  = document.getElementById('mediaInsertLinkBtn');
  const mediaInsertImageBtn = document.getElementById('mediaInsertImageBtn');
  const attachPickerModal   = document.getElementById('attachPickerModal');
  const closeAttachPicker   = document.getElementById('closeAttachPicker');
  const closeAttachPickerFt = document.getElementById('closeAttachPickerFooter');
  const attachPickerSearch  = document.getElementById('attachPickerSearch');
  const attachPickerList    = document.getElementById('attachPickerList');
  const attachPickerTitle   = document.getElementById('attachPickerTitle');

  // Picker mode: 'attach' (default, for sidebar chips), 'image' (embed img tag), 'file' (insert anchor link to doc)
  let pickerMode = 'attach';

  // Collect slugs of already-attached files (initially from server-rendered chips)
  let currentAttachments = Array.from(
    document.querySelectorAll('.attachment-chip')
  ).map(el => {
    const removeBtn = el.querySelector('.attachment-chip-remove');
    return removeBtn ? removeBtn.dataset.filename : null;
  }).filter(Boolean);

  function openAttachPicker(fromTinyMCE, fileType) {
    if (!attachPickerModal) return;
    if (fileType === 'image' || fileType === 'file') pickerMode = fileType;
    else pickerMode = fromTinyMCE ? 'file' : 'attach';
    if (attachPickerTitle) {
      if (pickerMode === 'image') attachPickerTitle.textContent = 'Insert Image (from uploads)';
      else if (pickerMode === 'file') attachPickerTitle.textContent = 'Insert Link to Uploaded Document';
      else attachPickerTitle.textContent = 'Attach File to Page';
    }
    if (fromTinyMCE) attachPickerModal.classList.add('modal-overlay--above-tinymce');
    else attachPickerModal.classList.remove('modal-overlay--above-tinymce');
    attachPickerModal.classList.remove('hidden');
    loadAttachPickerFiles();
    if (attachPickerSearch) {
      attachPickerSearch.value = '';
      setTimeout(() => attachPickerSearch.focus(), 80);
    }
  }

  function closeAttachPickerFn() {
    if (!attachPickerModal) return;
    // If we close while a TinyMCE picker was pending, notify TinyMCE by clearing
    if (pendingPicker) pendingPicker = null;
    pickerMode = 'attach';
    attachPickerModal.classList.add('hidden');
    attachPickerModal.classList.remove('modal-overlay--above-tinymce');
    if (attachPickerTitle) attachPickerTitle.textContent = 'Attach File to Page';
  }

  if (addAttachmentBtn) addAttachmentBtn.addEventListener('click', openAttachPicker);
  if (mediaInsertLinkBtn)  mediaInsertLinkBtn.addEventListener('click', function ()  { openAttachPicker(false, 'file');  });
  if (mediaInsertImageBtn) mediaInsertImageBtn.addEventListener('click', function () { openAttachPicker(false, 'image'); });
  if (closeAttachPicker) closeAttachPicker.addEventListener('click', closeAttachPickerFn);
  if (closeAttachPickerFt) closeAttachPickerFt.addEventListener('click', closeAttachPickerFn);
  if (attachPickerModal) {
    attachPickerModal.addEventListener('click', e => {
      if (e.target === attachPickerModal) closeAttachPickerFn();
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && attachPickerModal && !attachPickerModal.classList.contains('hidden')) {
      closeAttachPickerFn();
    }
  });

  async function loadAttachPickerFiles() {
    if (!attachPickerList) return;
    attachPickerList.innerHTML = '<p class="editor-hint">Loading…</p>';
    try {
      const res   = await fetch('/api/uploads');
      const files = await res.json();
      renderPickerFiles(files);
    } catch {
      attachPickerList.innerHTML = '<p class="editor-hint" style="color:var(--c-danger)">Failed to load files.</p>';
    }
  }

  function renderPickerFiles(files) {
    if (!attachPickerList) return;
    if (!files || files.length === 0) {
      attachPickerList.innerHTML =
        '<p class="editor-hint">No uploaded files found. <a href="/uploads" target="_blank" rel="noopener">Go to Uploads</a></p>';
      return;
    }

    const q = attachPickerSearch ? attachPickerSearch.value.toLowerCase() : '';
    let filtered = q ? files.filter(f => f.originalName.toLowerCase().includes(q)) : files;
    if (pickerMode === 'image') filtered = filtered.filter(f => IMAGE_EXT_RE.test(f.originalName) || IMAGE_EXT_RE.test(f.name));

    if (filtered.length === 0) {
      attachPickerList.innerHTML = pickerMode === 'image'
        ? '<p class="editor-hint">No image uploads found. <a href="/uploads" target="_blank" rel="noopener">Go to Uploads</a> to add PNG/JPG/GIF/SVG.</p>'
        : '<p class="editor-hint">No files match your search.</p>';
      return;
    }

    attachPickerList.innerHTML = filtered.map(f => {
      const already = pickerMode === 'attach' && currentAttachments.includes(f.name);
      const isImage = IMAGE_EXT_RE.test(f.name) || IMAGE_EXT_RE.test(f.originalName);
      const actionLabel =
        pickerMode === 'image' ? 'Embed Image' :
        pickerMode === 'file'  ? 'Insert Link' :
        already                ? '✓ Added'    : '+ Attach';
      return `
        <div class="attach-picker-item ${already ? 'already-attached' : ''} ${isImage ? 'is-image' : ''}"
             data-filename="${escHtml(f.name)}"
             data-originalname="${escHtml(f.originalName)}"
             role="button"
             tabindex="${already ? '-1' : '0'}"
             aria-disabled="${already}"
             aria-label="${escHtml(f.originalName)}${already ? ' (already attached)' : ''}">
          <span class="attach-picker-icon">${escHtml(f.icon)}</span>
          <div class="attach-picker-info">
            <span class="attach-picker-name">${escHtml(f.originalName)}</span>
            <span class="attach-picker-size">${escHtml(f.size)}</span>
          </div>
          <span class="attach-picker-add">${actionLabel}</span>
        </div>`;
    }).join('');

    // Bind click handlers
    attachPickerList.querySelectorAll('.attach-picker-item').forEach(item => {
      const disabled = item.classList.contains('already-attached');
      if (disabled) return;
      item.addEventListener('click', () => pickerItemChosen(item));
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickerItemChosen(item); }
      });
    });
  }

  function pickerItemChosen(item) {
    const filename     = item.dataset.filename;
    const originalName = item.dataset.originalname || filename.replace(/^\d+_/, '');
    if (pickerMode === 'attach') {
      attachFile(filename);
      return;
    }
    const ed = tinymce.activeEditor;
    const fileUrl = '/uploads/' + encodeURIComponent(filename);
    const isImage = pickerMode === 'image' || IMAGE_EXT_RE.test(originalName) || IMAGE_EXT_RE.test(filename);

    // --- Path 1: Opened via TinyMCE Browse (pendingPicker callback available) ---
    // We call the callback so TinyMCE populates the dialog fields (URL / Alt / etc.),
    // but many users forget to click the dialog's "Save" afterwards, so also insert
    // immediately below as a belt+braces fallback when dialog is about-to-close.
    if (pendingPicker && typeof pendingPicker.cb === 'function') {
      const cb   = pendingPicker.cb;
      const meta = pendingPicker.meta;
      pendingPicker = null;
      if (isImage || (meta && meta.filetype === 'image')) {
        try { cb(fileUrl, { title: originalName, alt: originalName }); } catch (_) { /* ignore */ }
      } else {
        try { cb(fileUrl, { text: originalName, title: originalName }); } catch (_) { /* ignore */ }
      }
      // Belt+braces: if after TinyMCE cb() nothing changed, force-insert now.
      // (Handles "I clicked Insert Link in picker, expected immediate insert" UX.)
      // Delay slightly so TinyMCE dialog DOM updates first, then close dialog + insert.
      setTimeout(function () {
        try {
          // Close TinyMCE's dialog so picker choice is the final action, not "still pending in dialog".
          // TinyMCE 7 does not expose windowManager.getWindows(); close via DOM Cancel / X buttons.
          const wraps = document.querySelectorAll('.tox-dialog-wrap');
          for (let i = 0; i < wraps.length; i++) {
            const w = wraps[i];
            const buttons = w.querySelectorAll('button');
            let fired = false;
            for (let j = 0; j < buttons.length && !fired; j++) {
              const label = (buttons[j].textContent || '').trim().toLowerCase();
              const cls = buttons[j].className || '';
              if (label === 'cancel' || (label === '' && cls.includes('tox-button--icon'))) {
                try { buttons[j].click(); fired = true; } catch (_) { /* ignore */ }
              }
            }
          }
        } catch (_) { /* ignore */ }
        // Force insert into editor if not yet present.
        // (Handles "I clicked Insert Link in picker, expected immediate insert" UX.)
        if (ed && !isInContentAlready(ed, fileUrl)) {
          if (isImage) insertImageDirect(ed, fileUrl, originalName);
          else         insertLinkDirect(ed, fileUrl, originalName);
        }
      }, 30);
      closeAttachPickerFn();
      return;
    }

    // --- Path 2: Opened via sidebar "Media" widget (no pendingPicker) ---
    // Insert directly into TinyMCE content without any extra dialog step.
    if (!ed) return;
    if (isImage) insertImageDirect(ed, fileUrl, originalName);
    else         insertLinkDirect(ed, fileUrl, originalName);
    closeAttachPickerFn();
  }

  function isInContentAlready(ed, url) {
    try {
      const html = ed.getContent() || '';
      return html.indexOf(url) !== -1;
    } catch (_) { return false; }
  }

  function insertImageDirect(ed, url, alt) {
    ed.focus();
    const safeUrl = String(url).replace(/"/g, '&quot;');
    const safeAlt = String(alt || '').replace(/"/g, '&quot;');
    ed.execCommand('mceInsertContent', false,
      '<img src="' + safeUrl + '" alt="' + safeAlt + '" title="' + safeAlt + '" />');
    ed.nodeChanged();
  }

  function insertLinkDirect(ed, url, text) {
    ed.focus();
    const selText = (ed.selection.getContent({ format: 'text' }) || '').trim();
    const linkText = selText.length > 0 ? selText : String(text || url);
    const safeUrl  = String(url).replace(/"/g,  '&quot;');
    const safeText = String(linkText).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeTitle = String(text || '').replace(/"/g, '&quot;');
    const html = '<a href="' + safeUrl + '" title="' + safeTitle + '" target="_blank" rel="noopener">' + safeText + '</a>';
    ed.execCommand('mceInsertContent', false, html);
    ed.nodeChanged();
  }

  if (attachPickerSearch) {
    attachPickerSearch.addEventListener('input', async function () {
      const res   = await fetch('/api/uploads');
      const files = await res.json();
      renderPickerFiles(files);
    });
  }

  async function attachFile(filename) {
    if (currentAttachments.includes(filename) || !WIKI.slug) return;
    try {
      const res = await fetch(`/pages/${WIKI.slug}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': WIKI.csrf },
        body: JSON.stringify({ filename })
      });
      if (!res.ok) throw new Error('Server error');
      currentAttachments.push(filename);
      addChipToDom(filename);
      closeAttachPickerFn();
    } catch {
      alert('Failed to attach file. Please try again.');
    }
  }

  function addChipToDom(filename) {
    const chips  = document.getElementById('attachmentChips');
    const noMsg  = document.getElementById('noAttachMsg');
    if (!chips) return;
    if (noMsg) noMsg.remove();
    const originalName = filename.replace(/^\d+_/, '');
    const safeId = 'chip_' + filename.replace(/[^a-zA-Z0-9]/g, '_');
    const chip   = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.id        = safeId;
    chip.innerHTML = `
      <span class="attachment-chip-name">${escHtml(originalName)}</span>
      <button type="button" class="attachment-chip-remove"
              data-filename="${escHtml(filename)}"
              data-slug="${escHtml(WIKI.slug)}"
              aria-label="Remove ${escHtml(originalName)}">×</button>`;
    chip.querySelector('.attachment-chip-remove').addEventListener('click', () => detachFile(filename));
    chips.appendChild(chip);
  }

  async function detachFile(filename) {
    if (!WIKI.slug) return;
    try {
      const res = await fetch(`/pages/${WIKI.slug}/detach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': WIKI.csrf },
        body: JSON.stringify({ filename })
      });
      if (!res.ok) throw new Error('Server error');
      currentAttachments = currentAttachments.filter(f => f !== filename);
      const safeId = 'chip_' + filename.replace(/[^a-zA-Z0-9]/g, '_');
      const chip   = document.getElementById(safeId);
      if (chip) chip.remove();
      const chips = document.getElementById('attachmentChips');
      if (chips && chips.children.length === 0) {
        const p    = document.createElement('p');
        p.id       = 'noAttachMsg';
        p.className = 'editor-hint';
        p.textContent = 'No attachments yet.';
        chips.appendChild(p);
      }
    } catch {
      alert('Failed to remove attachment. Please try again.');
    }
  }

  // Wire up initial chip remove buttons (server-rendered)
  document.querySelectorAll('.attachment-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => detachFile(btn.dataset.filename));
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function mimeToExt(mime) {
    switch (String(mime).toLowerCase()) {
      case 'image/png':  return '.png';
      case 'image/jpeg': return '.jpg';
      case 'image/gif':  return '.gif';
      case 'image/svg+xml': return '.svg';
      case 'image/webp': return '.webp';
      case 'image/bmp':  return '.bmp';
      default:           return '.png';
    }
  }
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
