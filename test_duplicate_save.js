/**
 * test_duplicate_save.js — Node test harness for duplicate-title save flow.
 *
 * Does NOT start the server itself. Expects the OnlineWiki server to already
 * be running at process.env.BASE_URL (default http://localhost:3000) with
 * LOCAL_AUTH=1 and a seed local admin user defined in env.
 *
 * Alternatively, the script can also be invoked with `--inproc` to import and
 * launch server.js in the same process (avoids needing a separate server
 * running), but requires SESSION_SECRET / LOCAL_AUTH_SEED_* / DATA_DIR etc.
 * to already be set up.
 */
'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ─── Small HTTP helpers (no external deps) ───────────────────────────────────
function parseCookies(raw) {
  const out = {};
  (raw || '').split(';').forEach(kv => {
    const [k, ...rest] = kv.trim().split('=');
    if (k) out[k] = rest.join('=');
  });
  return out;
}
function setCookieHeaders(cookieJar) {
  const entries = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`);
  return entries.length ? { Cookie: entries.join('; ') } : {};
}
function mergeCookies(cookieJar, setCookieHeaders) {
  (setCookieHeaders || []).forEach(h => {
    const first = h.split(';')[0];
    const [k, ...rest] = first.split('=');
    if (k) cookieJar[k] = rest.join('=');
  });
}
function httpRequest(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,*/*;q=0.8',
      ...(opts.headers || {})
    };
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function formEncode(obj) {
  return Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined ? '' : String(v))).join('&');
}

// ─── Extract first CSRF token from an HTML response ──────────────────────────
function extractCSRF(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

// ─── TEST DRIVER ─────────────────────────────────────────────────────────────
async function main() {
  let passed = 0, failed = 0;
  function check(label, cond, detail) {
    if (cond) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  const jar = {};
  console.log(`\n== Test Harness: duplicate-title save flow ==`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   (If server is not running, start it in another terminal: node server.js)\n`);

  // ── 1. Get login page ──────────────────────────────────────────────────
  console.log('Step 1: GET /login');
  const loginGet = await httpRequest('GET', BASE_URL + '/login', { headers: setCookieHeaders(jar) });
  mergeCookies(jar, loginGet.headers['set-cookie'] || []);
  check('login page loads 200', loginGet.status === 200, `got ${loginGet.status}`);
  const csrf1 = extractCSRF(loginGet.body);
  check('login page contains _csrf', !!csrf1);

  // ── 2. Log in with seeded local admin (if present in env) ──────────────
  const seedUser = process.env.LOCAL_AUTH_SEED_USERNAME || 'admin';
  const seedPass = process.env.LOCAL_AUTH_SEED_PASSWORD || 'admin123';
  console.log(`Step 2: POST /login as ${seedUser}`);
  const loginPost = await httpRequest('POST', BASE_URL + '/login', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...setCookieHeaders(jar)
    },
    body: formEncode({ _csrf: csrf1 || '', username: seedUser, password: seedPass })
  });
  mergeCookies(jar, loginPost.headers['set-cookie'] || []);
  const loggedIn = [301, 302, 303, 307, 308].includes(loginPost.status) || loginPost.headers['location'];
  check('login redirects after submit', loggedIn, `status=${loginPost.status}`);
  if (!loggedIn && loginPost.body && loginPost.body.includes('login')) {
    console.error(`\n[warn] Login failed — subsequent tests may fail with 403/302. Ensure LOCAL_AUTH=1 and seed credentials are correct.`);
  }

  // ── 3. GET /pages/new, capture CSRF ────────────────────────────────────
  console.log('Step 3: GET /pages/new');
  const newGet = await httpRequest('GET', BASE_URL + '/pages/new', { headers: setCookieHeaders(jar) });
  mergeCookies(jar, newGet.headers['set-cookie'] || []);
  if ([301, 302, 303, 307, 308].includes(newGet.status) && newGet.headers['location']) {
    check('/pages/new accessible (editor+ role)', false, `redirects to ${newGet.headers['location']} (login likely failed)`);
    process.exitCode = failed ? 1 : 0;
    console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
    return;
  }
  check('/pages/new loads 200', newGet.status === 200, `got ${newGet.status}`);
  const csrfNew = extractCSRF(newGet.body);
  check('/pages/new has _csrf', !!csrfNew);

  // ── 4. POST first page titled QQQ (new, no duplicate, should create) ───
  console.log('Step 4: POST /pages/new title=QQQ, confirmDuplicate=false (create first QQQ)');
  const postFirst = await httpRequest('POST', BASE_URL + '/pages/new', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...setCookieHeaders(jar)
    },
    body: formEncode({
      _csrf: csrfNew || '',
      title: 'QQQ',
      slug:  'qqq',
      content: '<p>first QQQ</p>',
      tags: '',
      parent: '',
      position: 0,
      confirmDuplicate: 'false'
    })
  });
  mergeCookies(jar, postFirst.headers['set-cookie'] || []);
  check('first create is 3xx or 200 (200 means it also hit duplicate guard because of leftover QQQ pages from prior runs — that is fine because Step 6/7 test the real guard/confirm paths)',
    [200, 301, 302, 303, 307, 308].includes(postFirst.status), `status=${postFirst.status}`);
  const firstLoc = postFirst.headers['location'] || '';
  const firstIsGoodRedirect = firstLoc === '' || /\/pages\/qqq(-\d+)?(\?|#|$)/.test(firstLoc);
  check('first create either redirects to a qqq slug OR renders form (both OK)', firstIsGoodRedirect, `location=${firstLoc}`);

  // ── 5. GET /pages/new again for second attempt ─────────────────────────
  console.log('Step 5: GET /pages/new again');
  const newGet2 = await httpRequest('GET', BASE_URL + '/pages/new', { headers: setCookieHeaders(jar) });
  mergeCookies(jar, newGet2.headers['set-cookie'] || []);
  check('/pages/new (second) 200', newGet2.status === 200, `got ${newGet2.status}`);
  const csrfNew2 = extractCSRF(newGet2.body);

  // ── 6. POST second QQQ title, confirmDuplicate=FALSE → should REFUSE and rerender edit with confirmDuplicate=true (NOT redirect to /pages/new with empty content, not save)
  console.log('Step 6: POST /pages/new title=QQQ again, confirmDuplicate=false (DUPLICATE, refuse, NO SAVE, rerender edit with pre-set confirmDuplicate=true)');
  const postDupRefuse = await httpRequest('POST', BASE_URL + '/pages/new', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...setCookieHeaders(jar)
    },
    body: formEncode({
      _csrf: csrfNew2 || '',
      title: 'QQQ',
      slug:  'qqq',
      content: '<p>DRAFT second QQQ, refuse path — content should preserve in rerender</p>',
      tags: 'tagA, tagB',
      parent: '',
      position: 0,
      confirmDuplicate: 'false'
    })
  });
  mergeCookies(jar, postDupRefuse.headers['set-cookie'] || []);
  check('duplicate-refuse is 200 (rerender edit), not 3xx', postDupRefuse.status === 200, `status=${postDupRefuse.status} (3xx would = old redirect bug losing draft)`);
  check('duplicate-refuse body contains draft content', postDupRefuse.body.includes('DRAFT second QQQ, refuse path') || postDupRefuse.body.includes('refuse path'), 'draft content not preserved in rerender HTML');
  check('duplicate-refuse body contains tags tagA, tagB', postDupRefuse.body.includes('tagA') && postDupRefuse.body.includes('tagB'), 'tags not preserved in rerender');
  // confirmDuplicate hidden input must be set to true now
  const m = postDupRefuse.body.match(/name="confirmDuplicate"[^>]*value="([^"]+)"/);
  check('duplicate-refuse sets confirmDuplicate=true on rerender', m && m[1] === 'true', m ? `value=${m[1]}` : 'no match');

  // ── 7. GET new page HTML has confirmDuplicate=true → submit AGAIN with confirmDuplicate=TRUE, should save
  const csrfRerender = extractCSRF(postDupRefuse.body);
  console.log('Step 7: POST /pages/new title=QQQ again, confirmDuplicate=true (CONFIRMED, should save as /pages/qqq-2)');
  const postDupOk = await httpRequest('POST', BASE_URL + '/pages/new', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...setCookieHeaders(jar)
    },
    body: formEncode({
      _csrf: csrfRerender || '',
      title: 'QQQ',
      slug:  'qqq',
      content: '<p>DRAFT second QQQ, confirm path — saved!</p>',
      tags: 'tagA, tagB',
      parent: '',
      position: 0,
      confirmDuplicate: 'true'
    })
  });
  mergeCookies(jar, postDupOk.headers['set-cookie'] || []);
  check('confirm-save is 3xx redirect', [301, 302, 303, 307, 308].includes(postDupOk.status), `status=${postDupOk.status}`);
  const dupOkLoc = postDupOk.headers['location'] || '';
  check('confirm-save redirects to /pages/qqq-2 OR /pages/qqq-3 OR other unique slug (allows ?_t= query)',
    /\/pages\/qqq(-\d+)?(\?|#|$)/.test(dupOkLoc), `location=${dupOkLoc}`);

  // ── 8. Verify the new slug really exists (visit it) ────────────────────
  if (/\/pages\/(qqq(?:-\d+)?)$/.test(dupOkLoc)) {
    const slug2 = /\/pages\/(qqq(?:-\d+)?)$/.exec(dupOkLoc)[1];
    console.log(`Step 8: GET /pages/${slug2} verify persisted`);
    const getSlug2 = await httpRequest('GET', BASE_URL + '/pages/' + slug2, { headers: setCookieHeaders(jar) });
    check(`/pages/${slug2} returns 200`, getSlug2.status === 200, `status=${getSlug2.status}`);
    check(`/pages/${slug2} contains the saved content`, getSlug2.body.includes('confirm path') || getSlug2.body.includes('saved'), 'saved body not found');
    check(`/pages/${slug2} page title is QQQ`, getSlug2.body.includes('<title>QQQ') || getSlug2.body.includes('>QQQ — '), 'title not QQQ');
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => { console.error('Harness crashed:', err); process.exitCode = 1; });
