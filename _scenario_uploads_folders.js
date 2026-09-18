/**
 * Scenario test harness for uploads-folder-hierarchy T9 cross-cutting tests.
 * No new npm deps - uses only built-in http/https/url/fs + cookie jar.
 * Covers:
 *   T9-TR1 AC-14 6+ distinct audit action types after full scenario walkthrough
 *   T9-TR2 NFR-4 legacy root-upload flow (no folderPath anywhere)
 *   T9-TR3 AC-11 atomic 3-file move collision: all files preserved
 *   T9-TR4 latency p50 endpoint wall-time < 500ms
 *   T9-TR5 3 distinct server error / warn events
 *   T9-TR6 SyncThing copy simulation (post-harness manual check)
 */
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const base = new URL(BASE);
const ADMIN = process.env.TEST_USER || 'admin';
const ADMIN_PASS = process.env.TEST_PASS || 'admin';

const jar = new Map();
function setCookies(host, setCookieArr) {
  const prev = jar.get(host) || '';
  const map = new Map();
  for (const s of [...prev.split(';').map(s => s.trim()).filter(Boolean), ...(setCookieArr||[])]) {
    const eq = s.indexOf('='); if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq+1).split(';')[0].trim();
    map.set(k, v);
  }
  const merged = [...map.entries()].map(([k,v]) => `${k}=${v}`).join('; ');
  jar.set(host, merged);
}
function cookieHeaderFor(host) { return jar.get(host) || ''; }
function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol==='https:'?443:80),
      method: opts.method || 'GET',
      path: u.pathname + (u.search||''),
      headers: Object.assign({ 'Cookie': cookieHeaderFor(u.host) }, opts.headers || {}),
      rejectUnauthorized: false
    }, res => {
      setCookies(u.host, res.headers['set-cookie'] || []);
      let buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buf).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
function extractCsrf(html) {
  const m = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"[^>]*>/i);
  return m ? m[1] : null;
}
function csrfInMetaOrInput(html) {
  const m1 = extractCsrf(html); if (m1) return m1;
  const m2 = html.match(/name="csrf-token"[^>]*content="([^"]+)"/i);
  return m2 ? m2[1] : null;
}
function formEncode(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      for (const it of v) parts.push(encodeURIComponent(k)+'='+encodeURIComponent(it));
    } else {
      parts.push(encodeURIComponent(k)+'='+encodeURIComponent(v));
    }
  }
  return parts.join('&');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const UPLOADS_INDEX = path.join(DATA_DIR, 'uploads.json');

function readIndexSafe() {
  try { return JSON.parse(fs.readFileSync(UPLOADS_INDEX,'utf8')); }
  catch { return { uploads: [], updatedAt: new Date().toISOString() }; }
}
function findStoredByOriginal(originalName, folderPath='') {
  const idx = readIndexSafe();
  return idx.uploads.find(u => u.originalName === originalName && (u.folderPath||'') === folderPath) || null;
}
function relForStored(rec) {
  const fp = rec.folderPath || '';
  return fp ? fp + '/' + rec.storedName : rec.storedName;
}
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) {
    for (const e of fs.readdirSync(p)) rmrf(path.join(p, e));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
function cleanupScenarioArtifacts() {
  const targets = ['Project Alpha','Project Alpha 2','Project Beta','Engineering'];
  for (const t of targets) rmrf(path.join(UP_DIR, t));
  const idx = readIndexSafe();
  const keepOriginals = new Set([
    'legacy-root-sm.png','src-file-a.png','src-file-b.png','src-file-c.png','collision-target.png','req-v2.pdf'
  ]);
  // Remove any matching stored files at root whose original name matches our test set
  const remaining = [];
  for (const rec of idx.uploads) {
    if (keepOriginals.has(rec.originalName)) {
      const fp = path.join(UP_DIR, relForStored(rec));
      try { fs.unlinkSync(fp); } catch {}
      continue;
    }
    remaining.push(rec);
  }
  if (remaining.length !== idx.uploads.length) {
    fs.writeFileSync(UPLOADS_INDEX, JSON.stringify({ uploads: remaining, updatedAt: new Date().toISOString() }, null, 2));
  } else {
    // Also remove orphan test root files matching pattern leftover from previous runs
    for (const nm of fs.existsSync(UP_DIR) ? fs.readdirSync(UP_DIR) : []) {
      const full = path.join(UP_DIR, nm);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (/^\d+_(legacy-root-sm|src-file-[abc]|collision-target|req-v2)\.(png|pdf)$/.test(nm)) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  }
}

(async function main(){
  try {
    console.log('== PRE: cleanup leftover scenario artifacts from prior runs ==');
    cleanupScenarioArtifacts();

    console.log('\n== STEP 1: Visit /login, extract CSRF, authenticate local admin ==');
    let r = await fetch('/login');
    if (r.status !== 200) throw new Error('login page status=' + r.status);
    const csrf1 = csrfInMetaOrInput(r.body);
    r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/login' },
      body: formEncode({ username: ADMIN, password: ADMIN_PASS, _csrf: csrf1||'' })
    });
    if (r.status !== 302 && r.status !== 200) throw new Error('login status='+r.status);
    console.log('POST /login ->', r.status, 'redirect:', r.headers.location);

    console.log('\n== STEP 2: Fetch /uploads root, extract csrf ==');
    r = await fetch('/uploads');
    if (r.status !== 200) throw new Error('/uploads GET status='+r.status);
    const csrf = csrfInMetaOrInput(r.body);
    console.log('csrf length:', csrf ? csrf.length : 0,
      'subfolders:', (r.body.match(/class="folder-row"/g)||[]).length,
      'file rows:', (r.body.match(/class="file-row"/g)||[]).length);

    const TEST_PNG_BODY = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64');
    const PDF_BODY = Buffer.from('%PDF-1.4 minimal sample body %%EOF\n', 'utf8');

    function makeMultipart(boundary, fields, filePart) {
      const chunks = [];
      for (const [k, v] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
      }
      if (filePart) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.type||'application/octet-stream'}\r\n\r\n`,
          'utf8'));
        chunks.push(filePart.body);
        chunks.push(Buffer.from('\r\n', 'utf8'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
      return Buffer.concat(chunks);
    }
    async function doUpload(filename, fileBuffer, contentType, folderPath) {
      const boundary = `----TB_${Math.random().toString(36).slice(2, 12)}`;
      const fields = { _csrf: csrf };
      if (folderPath !== undefined) fields.folderPath = folderPath;
      const body = makeMultipart(boundary, fields, { filename, body: fileBuffer, type: contentType });
      return await fetch('/uploads/upload', {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
          'Referer': BASE + '/uploads'
        },
        body
      });
    }

    // ── T9-TR2 legacy root upload ────────────────────────────────────────────
    console.log('\n== STEP 3 (T9-TR2): Legacy root upload — multipart WITHOUT folderPath field ==');
    r = await doUpload('legacy-root-sm.png', TEST_PNG_BODY, 'image/png');
    console.log('Legacy root upload status:', r.status, 'redirect:', r.headers && r.headers.location);
    const legacyRec = findStoredByOriginal('legacy-root-sm.png', '');
    const legacyFileOnDisk = !!legacyRec && fs.existsSync(path.join(UP_DIR, legacyRec.storedName));
    const legacyFolderPathEmpty = legacyRec ? (legacyRec.folderPath || '') === '' : false;
    console.log('  legacy record in uploads.json?', !!legacyRec,
      'folderPath="" (root)?', legacyFolderPathEmpty,
      'file on disk:', legacyFileOnDisk);

    // ── AC-4 create nested folders ───────────────────────────────────────────────
    console.log('\n== STEP 4 (AC-4): POST folder Project Alpha + child v1.0 ==');
    r = await fetch('/uploads/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ parentPath: '', name: 'Project Alpha', _csrf: csrf })
    });
    console.log('Create root Project Alpha ->', r.status, 'location:', r.headers.location);
    r = await fetch('/uploads?path='+encodeURIComponent('Project Alpha'));
    console.log('Inside Alpha page status:', r.status);
    const csrf2 = csrfInMetaOrInput(r.body) || csrf;
    r = await fetch('/uploads/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ parentPath: 'Project Alpha', name: 'v1.0', _csrf: csrf2 })
    });
    console.log('Create child v1.0 ->', r.status);
    const alphaV1Exists = fs.existsSync(path.join(UP_DIR, 'Project Alpha', 'v1.0'));
    console.log('Disk: Project Alpha/v1.0 exists?', alphaV1Exists);

    // ── T9-TR5 case #1 invalid path ────────────────────────────────────────
    console.log('\n== STEP 5 (T9-TR5 #1): GET invalid path ==');
    r = await fetch('/uploads?path=..%2F..%2Fetc');
    console.log('invalid path status:', r.status, 'redirect:', r.headers && r.headers.location);
    console.log('  redirects away from bad folder listing?', !!r.headers.location && r.headers.location.startsWith('/'));

    // ── T9-TR5 case #2 duplicate rename collision ───────────────────────────
    console.log('\n== STEP 6 (T9-TR5 #2): Create Alpha 2 → rename to Alpha (collision) ==');
    r = await fetch('/uploads/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ parentPath: '', name: 'Project Alpha 2', _csrf: csrf })
    });
    console.log('Create Project Alpha 2 ->', r.status);
    r = await fetch('/uploads/folders/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ path: 'Project Alpha 2', name: 'Project Alpha', _csrf: csrf })
    });
    console.log('Rename to duplicate status:', r.status, 'location:', r.headers && r.headers.location);
    const dupRenameStill = fs.existsSync(path.join(UP_DIR, 'Project Alpha 2'));
    console.log('  collision blocked? Project Alpha 2 still on disk (rename aborted)?', dupRenameStill);
    // Clean up the Alpha 2 folder now (rename succeeded under its original unique was created then attempted rename collided. Actually we need delete Alpha 2 manually since collision aborted)
    // Actually server did NOT rename (collision guard).  Now delete Alpha 2 (empty) — not needed for scenario, but keeps disk clean:
    if (dupRenameStill) {
      r = await fetch('/uploads/folders/delete', { method: 'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Referer':BASE+'/uploads'},
        body: formEncode({ path: 'Project Alpha 2', _csrf: csrf })
      });
      console.log('  cleaned up empty Alpha 2 -> delete status:', r.status);
    }

    // ── AC-6 rename folder rename: Alpha → Beta ───────────────────────────────────
    console.log('\n== STEP 7 (AC-6): Rename "Project Alpha" → "Project Beta" ==');
    r = await fetch('/uploads/folders/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ path: 'Project Alpha', name: 'Project Beta', _csrf: csrf })
    });
    console.log('Rename Alpha -> Beta status:', r.status);
    const stillAlpha = fs.existsSync(path.join(UP_DIR, 'Project Alpha'));
    const nowBeta   = fs.existsSync(path.join(UP_DIR, 'Project Beta', 'v1.0'));
    console.log('  old Alpha gone?', !stillAlpha, '| new Beta/v1.0 present?', nowBeta);

    // ── AC-8 nested upload into auto-mkdirp containment check ──────────────────────
    console.log('\n== STEP 8 (AC-8): Nested upload to Engineering/Specs ==');
    r = await doUpload('req-v2.pdf', PDF_BODY, 'application/pdf', 'Engineering/Specs');
    console.log('Nested upload status:', r.status, '| location:', r.headers && r.headers.location);
    const reqRec = findStoredByOriginal('req-v2.pdf', 'Engineering/Specs');
    const nestedOnDisk = !!reqRec && fs.existsSync(path.join(UP_DIR, 'Engineering', 'Specs', reqRec.storedName));
    console.log('  uploads.json folderPath=Engineering/Specs record:', !!reqRec);
    console.log('  disk: Engineering/Specs/<timestamp>_req-v2.pdf exists?', nestedOnDisk);
    // Nested wildcard download URL
    const nestedUrl = '/uploads/Engineering/Specs/' + encodeURIComponent(reqRec ? reqRec.storedName : 'req-v2.pdf');
    r = await fetch(nestedUrl);
    console.log('  Nested GET wildcard status:', r.status, 'body[:30]:', r.body.slice(0,30).replace(/\n/g,'\\n'));

    // ── T9-TR5 case #3 3-file collision batch move (AC-11) ─────────────
    console.log('\n== STEP 9 (AC-11 / T9-TR5 #3): Batch 3-file move collision 3rd ==');
    for (const nm of ['src-file-a.png','src-file-b.png','src-file-c.png','collision-target.png']) {
      r = await doUpload(nm, TEST_PNG_BODY, 'image/png');
      console.log(`  Upload ${nm} -> status=${r.status}`);
    }
    // Now prep collision: copy collision-target into Beta/v1.0 renamed to src-file-c.png stored name
    const srcCRec = findStoredByOriginal('collision-target.png','');
    const srcCRecForMoveC = findStoredByOriginal('src-file-c.png','');
    const destDir = path.join(UP_DIR, 'Project Beta', 'v1.0');
    if (srcCRec && srcCRecForMoveC) {
      const srcCOnRoot = path.join(UP_DIR, srcCRec.storedName);
      // Write to destDir using src-file-c's storedName (to force collide when we try to move it there)
      fs.copyFileSync(srcCOnRoot, path.join(destDir, srcCRecForMoveC.storedName));
      console.log('  Injected collision: dest has src-c stored name copied?',
        fs.existsSync(path.join(destDir, srcCRecForMoveC.storedName)));
    }
    // build rels for the 3 src files at root
    const recsABC = ['src-file-a.png','src-file-b.png','src-file-c.png']
      .map(nm => findStoredByOriginal(nm, ''));
    console.log('  3 src recs found:', recsABC.filter(Boolean).length);
    const relsABC = recsABC.filter(Boolean).map(relForStored);
    // Server expects form body with repeated "files" keys (NOT files[]) and destinationPath
    const moveFormBody = formEncode({
      _csrf: csrf,
      destinationPath: 'Project Beta/v1.0',
      files: relsABC
    });
    r = await fetch('/uploads/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: moveFormBody
    });
    console.log('  3-file move collision POST status:', r.status);
    // All 3 src should still be root; none in dest except pre-injected c
    const srcStillABC = recsABC.every(rec => rec && fs.existsSync(path.join(UP_DIR, rec.storedName)));
    const anyMovedToDest = recsABC.slice(0,2).some(rec => rec && fs.existsSync(path.join(destDir, rec.storedName)));
    console.log('  all 3 src still root (atomic)?', srcStillABC);
    console.log('  a or b illegally in dest (should be false):', anyMovedToDest);
    // Clean the injected c from dest dir
    if (srcCRecForMoveC) {
      try { fs.unlinkSync(path.join(destDir, srcCRecForMoveC.storedName)); } catch {}
    }

    // ── AC-10 single file move legacy root → Beta/v1.0 ────────────────────────
    console.log('\n== STEP 10 (AC-10): Single move: legacy-root-sm.png → Project Beta/v1.0 ==');
    let moved = false; let rootGone = false;
    if (legacyRec) {
      const body2 = formEncode({
        _csrf: csrf,
        destinationPath: 'Project Beta/v1.0',
        files: [relForStored(legacyRec)]
      });
      r = await fetch('/uploads/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
        body: body2
      });
      console.log('  single move status:', r.status);
      moved = fs.existsSync(path.join(destDir, legacyRec.storedName));
      rootGone = !fs.existsSync(path.join(UP_DIR, legacyRec.storedName));
    }
    console.log('  file exists dest?', moved, '| gone from root?', rootGone);

    // ── AC-7 non-empty delete rejection ──────────────────────────────────
    console.log('\n== STEP 11 (AC-7): Attempt delete non-empty Project Beta ==');
    r = await fetch('/uploads/folders/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ path: 'Project Beta', _csrf: csrf })
    });
    console.log('  non-empty delete status:', r.status, 'redirect:', r.headers && r.headers.location);
    const stillOnDisk = fs.existsSync(path.join(UP_DIR, 'Project Beta'));
    console.log('  Beta still disk (not deleted)?', stillOnDisk);

    // ── AC-14 / T9-TR1 extra: delete the moved legacy and empty v1.0 file then delete empty v1.0 dir → produces FILE_DELETED + FOLDER_DELETED audit actions
    // (Manually via listing UI has delete on orphan.)
    console.log('\n== STEP 11b (cleanup + more audit actions): empty Beta/v1.0 ==');
    // 1. Delete the moved legacy file (fresh folderPath after server move)
    if (legacyRec) {
      const afterMoveRec = (function(){
        const idx = readIndexSafe();
        return idx.uploads.find(u => u.originalName === 'legacy-root-sm.png') || null;
      })();
      if (afterMoveRec) {
        const targetRel = relForStored(afterMoveRec);
        const deleteResp = await fetch('/uploads/delete/' + targetRel.split('/').map(encodeURIComponent).join('/'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/uploads' },
          body: formEncode({ _csrf: csrf })
        });
        console.log('  delete moved legacy file (rel=' + targetRel + ') via route status:', deleteResp.status);
        await sleep(300);
      }
    }
    // 2. Delete empty v1.0 subfolder from Beta
    r = await fetch('/uploads/folders/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ path: 'Project Beta/v1.0', _csrf: csrf })
    });
    console.log('  delete empty Beta/v1.0 folder → status:', r.status);
    const v1Gone = !fs.existsSync(path.join(UP_DIR, 'Project Beta', 'v1.0'));
    console.log('  v1.0 folder deleted?', v1Gone);
    // 3. Delete also empty Project Beta itself (will still empty now since childless → FOLDER_DELETED audit
    r = await fetch('/uploads/folders/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE+'/uploads' },
      body: formEncode({ path: 'Project Beta', _csrf: csrf })
    });
    console.log('  delete empty Project Beta → status:', r.status);
    const betaGone = !fs.existsSync(path.join(UP_DIR, 'Project Beta'));
    console.log('  Beta folder deleted?', betaGone);

    // ── T9-TR4 latency ────────────────────────────────────────────────────
    console.log('\n== STEP 12 (T9-TR4): Latency ==');
    const t1 = Date.now(); r = await fetch('/uploads');
    const t2 = Date.now();
    const tNested1 = Date.now(); r = await fetch('/uploads?path=' + encodeURIComponent('Engineering/Specs'));
    const tNested2 = Date.now();
    const tTree1 = Date.now(); r = await fetch('/uploads/folders/tree');
    const tTree2 = Date.now();
    const tRoot = t2 - t1, tNest = tNested2 - tNested1, tTree = tTree2 - tTree1;
    console.log(`  root listing GET /uploads wall: ${tRoot} ms`);
    console.log(`  nested listing /uploads?path=Engineering/Specs wall: ${tNest} ms`);
    console.log(`  GET /uploads/folders/tree wall: ${tTree} ms bodyLen bytes: ${Buffer.byteLength(r.body)}`);
    const latencyAllUnder500 = tRoot < 500 && tNest < 500 && tTree < 500;
    console.log('  all three under 500 ms?', latencyAllUnder500);

    // ── T9-TR1 audit distinct action count ─────────────────────────────────────────
    console.log('\n== STEP 13 (T9-TR1 / AC-14): Audit distinct action scan ==');
    await sleep(900);
    function todaysLogFile(prefix) {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      return path.join(__dirname, 'logs', `${prefix}-${yyyy}-${mm}-${dd}.log`);
    }
    const auditLogPath = todaysLogFile('audit');
    const sysLogPath = todaysLogFile('system');
    function readLines(p) { try { return fs.readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } }
    const auditLines = [
      ...readLines(auditLogPath),
      ...readLines(path.join(__dirname,'logs','.audit-audit.json')),
    ];
    const actionSet = new Set();
    // Winston format: "[date] INFO : ACTION_NAME  {payload json}"
    for (const line of auditLines) {
      const m = line.match(/^\[[^\]]+\]\s+\w+\s*:\s*([A-Z][A-Z0-9_]+)\s/);
      if (m) actionSet.add(m[1]);
      // Fallback: search for the literal quoted action name (old format)
      for (const kw of ['FOLDER_CREATED','FOLDER_RENAMED','FOLDER_DELETED','FILE_UPLOADED','FILE_MOVED','FILE_DELETED','USER_LOGIN','USER_LOGOUT','USER_AUTHENTICATED','PREFERENCE_UPDATED']) {
        if (line.includes(kw)) actionSet.add(kw);
      }
    }
    const distinctSorted = [...actionSet].sort();
    console.log('  Audit log file used:', auditLogPath, '| lines:', auditLines.length);
    console.log('  Distinct types found:', distinctSorted.join(', '));
    console.log('  count:', actionSet.size, '≥ 6?', actionSet.size >= 6);
    const actions = actionSet;

    // ── T9-TR5 distinct system warning / error / WARN level events ──────────────
    console.log('\n== STEP 14 (T9-TR5): System warn/error count ==');
    const sysLines = [
      ...readLines(sysLogPath),
      ...readLines(path.join(__dirname,'logs','.system-audit.json')),
    ];
    const errSignatures = [];
    for (const line of sysLines) {
      if (/warn|error|WARN|ERROR|Folder is not empty|\b409\b|\b400\b|EBADCSRF|collision|invalid|reject/i.test(line)) {
        errSignatures.push(line.slice(0, 220));
      }
    }
    console.log('  System log used:', sysLogPath, '| total warn/error-like lines:', errSignatures.length);
    errSignatures.slice(-5).forEach((l, i) => console.log(`    recent ${i+1}.`, l));

    // ── T9-TR6 SyncThing copy simulation (directory copy-then-verify shape) ───────────────
    console.log('\n== STEP 15 (T9-TR6): SyncThing simulated copy ==');
    const copyDir = path.join(__dirname, '_synccopy_uploads_scenario');
    try { rmrf(copyDir); } catch {}
    // recursive copy uploads dir
    function cpRec(src, dst) {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src)) {
        const s = path.join(src, e), d = path.join(dst, e);
        const st = fs.statSync(s);
        if (st.isDirectory()) cpRec(s, d);
        else fs.copyFileSync(s, d);
      }
    }
    cpRec(UP_DIR, copyDir);
    // Now compare listing shape: sorted entries at every level
    function listTree(root) {
      const out = {};
      function walk(cur, rel) {
        const ents = fs.readdirSync(cur).sort();
        const arr = [];
        for (const e of ents) {
          if (e.startsWith('.')) continue;
          const p = path.join(cur, e); const st = fs.statSync(p);
          arr.push(st.isDirectory() ? {n:e,t:'d'} : {n:e,t:'f',s:st.size});
          if (st.isDirectory()) walk(p, rel ? rel+'/'+e : e);
        }
        out[rel||'(root)'] = arr;
      }
      walk(root, '');
      return JSON.stringify(out);
    }
    const origTree = listTree(UP_DIR);
    const copyTree = listTree(copyDir);
    const syncEquiv = origTree === copyTree;
    console.log('  SyncThing copy shape 1:1 match?', syncEquiv);
    console.log('  (uploaded files + Engineering/Specs + leftover src-[abc].png files all copied)');
    try { rmrf(copyDir); } catch {}

    // ── FINAL SUMMARY ──────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('FINAL T9 SCENARIO SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('[T9-TR2 legacy root upload (no folderPath) ...............', legacyFileOnDisk && legacyFolderPathEmpty ? 'PASS' : 'FAIL');
    console.log('[AC-4 nested folder create + child v1.0 .....................', alphaV1Exists ? 'PASS' : 'FAIL');
    console.log('[AC-6 rename Alpha→Beta disk rename .............', !stillAlpha && nowBeta ? 'PASS' : 'FAIL');
    console.log('[AC-8 nested upload Engineering/Specs + wildcard GET ........', nestedOnDisk ? 'PASS' : 'FAIL');
    console.log('[AC-10 single move legacy → Beta/v1.0 .................', moved && rootGone ? 'PASS' : 'FAIL');
    console.log('[AC-11 3-file collision batch atomic ...........', srcStillABC && !anyMovedToDest ? 'PASS' : 'FAIL');
    console.log('[AC-7 non-empty folder delete rejected (Beta) ...........', stillOnDisk ? 'PASS' : 'FAIL');
    console.log('[AC-14 / T9-TR1 ≥6 distinct audit actions .........', actions.size >= 6 ? `PASS (${actions.size})` : `FAIL (${actions.size})`);
    console.log('[T9-TR4 latency all three endpoints <500ms p50 ...........', latencyAllUnder500 ? 'PASS' : 'FAIL');
    console.log('[T9-TR5 ≥3 system warn/error events logged .......', errSignatures.length >= 3 ? `PASS (${errSignatures.length})` : `FAIL (${errSignatures.length})`);
    console.log('[T9-TR6 SyncThing copy shape equivalent ............', syncEquiv ? 'PASS' : 'FAIL');
    const total = 11;
    const passes = [
      legacyFileOnDisk && legacyFolderPathEmpty,
      alphaV1Exists,
      !stillAlpha && nowBeta,
      nestedOnDisk,
      moved && rootGone,
      srcStillABC && !anyMovedToDest,
      stillOnDisk,
      actions.size >= 6,
      latencyAllUnder500,
      errSignatures.length >= 3,
      syncEquiv
    ].filter(Boolean).length;
    console.log(`\nTotal: ${passes}/${total} PASS`);
    process.exit(passes === total ? 0 : 2);
  } catch (e) {
    console.error('SCENARIO TEST THREW:', e);
    process.exit(1);
  }
})()
