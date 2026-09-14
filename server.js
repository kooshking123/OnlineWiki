'use strict';
require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const FileStore      = require('session-file-store')(session);
let   RedisStore     = null;
try { RedisStore = require('connect-redis').default || require('connect-redis'); } catch { /* optional */ }
let   Redis          = null;
try { Redis = require('ioredis'); } catch { /* optional */ }
const passport       = require('passport');
const LdapStrategy   = require('passport-ldapauth');
const LocalStrategy  = require('passport-local').Strategy;
const flash          = require('connect-flash');
const multer         = require('multer');
const path           = require('path');
const fs             = require('fs-extra');
const slugify        = require('slugify');
const helmet         = require('helmet');
const morgan         = require('morgan');
const expressLayouts = require('express-ejs-layouts');
const crypto         = require('crypto');
const sanitizeHtml   = require('sanitize-html');
const { csrfSync }   = require('csrf-sync');
const { systemLogger, auditLogger } = require('./lib/logger');

// ─── Process-level crash guards ─────────────────────────────────────────────────
process.on('uncaughtException', err => {
  systemLogger.error('Uncaught exception', { error: err.message, stack: err.stack });
  // Give the logger time to flush, then exit so the process manager can restart
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  systemLogger.error('Unhandled promise rejection', { reason: String(reason) });
});

// ─── Startup security guard: bail on default / placeholder secrets ────────────
(function validateSecrets() {
  const isDev = process.env.NODE_ENV !== 'production';
  const fatal = [];
  const warn  = [];

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING' || secret === 'dev-secret-please-change') {
    (isDev ? warn : fatal).push('SESSION_SECRET is the default placeholder — generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }

  const adminUser = process.env.LOCAL_ADMIN_USERNAME;
  const adminPass = process.env.LOCAL_ADMIN_PASSWORD;
  if (!isDev && adminUser && adminPass) {
    if (adminUser === 'admin' || adminPass === 'admin' || adminPass === 'P@ssw0rd') {
      fatal.push(`LOCAL_ADMIN_USERNAME/PASSWORD are shipping with obvious default credentials (${adminUser}:***) — unset them in production to force LDAP-only auth.`);
    }
  }

  warn.forEach(m => systemLogger.warn('CONFIG: ' + m));
  if (fatal.length) {
    fatal.forEach(m => systemLogger.error('CONFIG FATAL: ' + m));
    console.error('\n❌ Refusing to start due to insecure configuration:\n' + fatal.map(m => '   • ' + m).join('\n') + '\n');
    process.exit(1);
  }
})();

// ─── CSRF protection (csrf-sync) ───────────────────────────────────────────────
const {
  invalidCsrfTokenError,
  generateToken,
  getTokenFromState,
  csrfSynchronisedProtection,
  getTokenFromRequest
} = csrfSync({
  getTokenFromRequest: (req) => {
    // --- Comma-duplicate-token hardening ----------------------------------
    // Illegal nested HTML <form> elements (e.g. a delete form inside the
    // outer page edit form) cause the browser to submit TWO inputs with
    // the same name `_csrf`. express.urlencoded({ extended:true }) merges
    // duplicate keys into a single comma-separated string of length
    // 256 + 1 + 256 = 513 — the exact "submitted len=513" 403 the user
    // reported for weeks.  Split on comma and accept the FIRST candidate
    // that passes the plausibility gate (the good token from the outer
    // form's explicit hidden input).  Without this, the merged garbage
    // always fails verification against the clean 256-char session value.
    function _firstPlausible(raw) {
      if (typeof raw !== 'string') return null;
      if (!raw.includes(',')) return _isPlausibleCsrf(raw) ? raw : null;
      for (const part of raw.split(',')) {
        const c = part.trim();
        if (_isPlausibleCsrf(c)) return c;
      }
      return null;
    }
    const bodyTok  = (req && req.body)  ? _firstPlausible(req.body._csrf)  : null;
    if (bodyTok) return bodyTok;
    const headTok = (req && req.headers) ? _firstPlausible(req.headers['x-csrf-token']) : null;
    if (headTok) return headTok;
    const qTok    = (req && req.query) ? _firstPlausible(req.query._csrf) : null;
    return qTok;
  },
  getTokenFromState: (req) => req?.session?._csrf,
  storeTokenInState: (req, token) => {
    if (req && req.session) {
      req.session._csrf = token;
      req.session.csrfToken = token;
    }
  }
});

// ── CSRF plausibility / session self-heal ─────────────────────────────────────
// csrf-sync v4 uses 256-byte tokens rendered as 342-char URL-safe base64
// (256 * 4/3 ceil = 344 bytes, less padding).  Older versions were ~256 chars.
// Anything >= ~400 chars in `req.session._csrf` is a corrupted double-token
// produced by a previous rotate-on-GET bug that stacked tokens during parallel
// session-file-store writes.  Anything below ~64 chars is empty / truncated.
// `_isPlausibleCsrf(tok)` acts as a fast gate: bad values are discarded and a
// fresh token is generated on the spot, self-healing sessions created before
// this fix.
function _isPlausibleCsrf(tok) {
  // csrf-sync default tokens: size=128 bytes random → hex = 256 chars.
  // Our manual fallback token: randomBytes(256) → base64url = ~342 chars.
  // Anything outside [16, 450] is impossible for both generators and
  // almost certainly a corrupted double-write (two 256-char tokens stacked
  // = exactly 512/513 chars, which was the persistent user-reported 403
  // len=513, submitted sha≠expected).  450 is chosen as a generous
  // ceiling ~30% above the longest plausible generator output.
  if (typeof tok !== 'string' || tok.length < 16) return false;
  if (tok.length > 450) return false;
  if (/[\s;,\x00]/.test(tok)) return false;
  return true;
}
function _manualFreshCsrf() {
  // Fallback generator if csrf-sync's generateToken is misbehaving (returns
  // a corrupted value due to bad session state).  Produces a 256-bit random
  // in URL-safe base64 (342 chars) — same shape as csrf-sync's default.
  return crypto.randomBytes(256).toString('base64url');
}

function csrfToken(req, res, next) {
  let tok = null;
  try { tok = getTokenFromState(req); } catch { tok = null; }

  if (tok !== null && !_isPlausibleCsrf(tok)) {
    try {
      if (req && req.session) {
        delete req.session._csrf;
        delete req.session.csrfToken;
      }
    } catch {}
    try {
      systemLogger.warn('CSRF discarded implausible stored token', {
        submittedLen: tok.length,
        ip: (req && req.ip) || null,
        user: (req && req.user && req.user.username) || null
      });
    } catch {}
    tok = null;
  }

  const finish = () => {
    if (!_isPlausibleCsrf(tok)) {
      try {
        const manual = _manualFreshCsrf();
        try {
          if (req && req.session) {
            req.session._csrf = manual;
            req.session.csrfToken = manual;
            req.session.save(e => {
              if (e) {
                try { systemLogger.warn('CSRF manual save fail', { error: e.message }); } catch {}
              }
            });
          }
        } catch {}
        tok = manual;
      } catch {
        try { tok = _manualFreshCsrf(); } catch { tok = 'CSRF_NOT_AVAILABLE_' + Date.now(); }
      }
    }
    res.locals.csrfToken = (typeof tok === 'string' && tok) ? tok : (_manualFreshCsrf() || 'csrf_fallback');
    if (typeof next === 'function') next();
  };

  if (tok) {
    finish();
    return;
  }

  try {
    tok = generateToken(req);
  } catch {
    tok = null;
  }
  if (tok && !_isPlausibleCsrf(tok)) {
    try {
      tok = _manualFreshCsrf();
      if (req && req.session) { req.session._csrf = tok; req.session.csrfToken = tok; }
    } catch { tok = null; }
  }

  if (tok && req.session && typeof req.session.save === 'function') {
    req.session.save((err) => {
      if (err) {
        try {
          systemLogger.warn('CSRF session.save failed', {
            error: err.message || String(err),
            ip: req.ip,
            user: (req.user && req.user.username) || null
          });
        } catch {}
      }
      finish();
    });
  } else {
    finish();
  }
}
function verifyCsrfConstantTime(req) {
  try {
    const candidate = getTokenFromRequest(req);
    const expected  = getTokenFromState(req);
    if (!candidate || !expected) return false;
    const a = Buffer.from(String(candidate));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Consolidated persistent storage root ──────────────────────────────────────
// All shared state (pages, uploads, avatars, sessions, users.json, settings.json)
// lives under DATA_DIR — the single folder that SyncThing (or DFS-N / SMB / NFS)
// needs to replicate across all OnlineWiki instances. Leave LOGS_DIR outside it
// because logs are per-server and must NOT be synced.
//
// DATA_DIR can be:
//   • relative (to process.cwd()) — e.g. 'data'  (default, backward compatible)
//   • absolute on a mapped drive  — e.g. 'X:\\OnlineWiki-Data'
//   • absolute UNC                — e.g. \\\\filer.corp\\wiki$  (if Windows runs as an account with share access)
const DATA_DIR = (process.env.DATA_DIR || 'data').trim() || 'data';
const LOGS_DIR = (process.env.LOG_DIR  || 'logs').trim() || 'logs';
// Absolute-resolve for logs: sessions store / assertWithinBaseDir / multer do their
// own resolve, but consistency is easier to debug when we print a canonical path.
const DATA_DIR_ABS = path.resolve(DATA_DIR);
const LOGS_DIR_ABS = path.resolve(LOGS_DIR);

// ─── Data subdirs + files (all under the single shared DATA_DIR) ──────────────
const PAGES_DIR     = path.join(DATA_DIR, 'pages');
const UPLOADS_DIR   = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR   = path.join(DATA_DIR, 'avatars');
const SESSIONS_DIR  = path.join(DATA_DIR, 'sessions');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const VIEWS_DIR    = path.join('views');
const PUBLIC_DIR   = path.join('public');
const TINYMCE_DIR  = path.join('node_modules', 'tinymce');

// Ensure storage layout exists before any route runs.
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(LOGS_DIR);
fs.ensureDirSync(PAGES_DIR);
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(AVATARS_DIR);
fs.ensureDirSync(SESSIONS_DIR);
// Ensure the users registry exists
if (!fs.existsSync(USERS_FILE)) fs.writeJsonSync(USERS_FILE, {}, { spaces: 2 });

// ─── Site-wide settings defaults + helpers ─────────────────────────────────────
const DEFAULT_SETTINGS = {
  siteTitle:     'OnlineWiki',
  siteTagline:   'Internal knowledge base and collaborative wiki',
  homeHeading:   'Wiki Home',
  homeSubtitle:  '{N} page{N_S}'
};
function loadSettings() {
  try {
    const raw = fs.readJsonSync(SETTINGS_FILE);
    return Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === 'object') ? raw : {});
  } catch {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}
function saveSettings(obj) {
  const clean = {};
  Object.keys(DEFAULT_SETTINGS).forEach(k => {
    clean[k] = typeof obj[k] === 'string' ? obj[k] : DEFAULT_SETTINGS[k];
  });
  writeJsonAtomic(SETTINGS_FILE, clean);
  return clean;
}
if (!fs.existsSync(SETTINGS_FILE)) {
  try { writeJsonAtomic(SETTINGS_FILE, Object.assign({}, DEFAULT_SETTINGS)); } catch { /* ignore */ }
}

// ─── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', false);
app.set('layout extractStyles', false);
app.set('layout extractMetas', false);
// HTML-escape helper available in every EJS render (home/page/admin/users/…).
// `escapeHtmlAttr` below is a function declaration (hoisted), so referencing it
// here is safe even though its body appears later in the file.
app.locals.e = escapeHtmlAttr;

// ─── Static assets ─────────────────────────────────────────────────────────────
// Serve TinyMCE from its npm package — no CDN/API-key required
app.use('/tinymce', express.static(TINYMCE_DIR));
app.use(express.static(PUBLIC_DIR));

// ─── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false  // Disabled: TinyMCE requires unsafe-inline + unsafe-eval
}));
// HTTP request logging via morgan → winston stream
app.use(morgan('combined', {
  stream: { write: msg => systemLogger.http(msg.trim()) },
  skip: (req) => req.path === '/favicon.ico'
}));

// ─── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// ─── Session: single-server file store / SyncThing-synced / Redis ──────────────
const SESSION_TTL_SECS  = (parseInt(process.env.SESSION_MAX_AGE_HOURS) || 8) * 3600;
const SESSION_MODE_RAW  = (process.env.SESSION_MODE || '').trim().toLowerCase();
const SESSION_MODE_ENUM = { SINGLE: 'single', SYNCTHING: 'syncthing', REDIS: 'redis' };

let SESSION_MODE = SESSION_MODE_ENUM.SINGLE;
{
  const redisConfigured = !!(process.env.REDIS_URL || process.env.REDIS_HOST);
  if      (SESSION_MODE_RAW === 'redis' || SESSION_MODE_RAW === 'redis-store')         SESSION_MODE = SESSION_MODE_ENUM.REDIS;
  else if (SESSION_MODE_RAW === 'syncthing' || SESSION_MODE_RAW === 'sync' || SESSION_MODE_RAW === 'shared-file') SESSION_MODE = SESSION_MODE_ENUM.SYNCTHING;
  else if (SESSION_MODE_RAW === 'single' || SESSION_MODE_RAW === 'local' || !SESSION_MODE_RAW) {
    SESSION_MODE = redisConfigured ? SESSION_MODE_ENUM.REDIS : SESSION_MODE_ENUM.SINGLE;
  } else {
    systemLogger.warn(`[session] Unknown SESSION_MODE '${process.env.SESSION_MODE}' — falling back to 'single'`);
    SESSION_MODE = SESSION_MODE_ENUM.SINGLE;
  }
  if (SESSION_MODE === SESSION_MODE_ENUM.REDIS && !redisConfigured) {
    systemLogger.warn('[session] SESSION_MODE=redis but REDIS_URL/REDIS_HOST not set — falling back to single-server file store');
    SESSION_MODE = SESSION_MODE_ENUM.SINGLE;
  }
}

let activeSessionStore = null;
let activeSessionIsReapable = false;

function buildFileStore({ useBuiltInReaper, sharedNotice }) {
  const store = new FileStore({
    path:         SESSIONS_DIR,
    ttl:          SESSION_TTL_SECS,
    retries:      5,
    reapInterval: useBuiltInReaper ? 3600 : -1,
    reapAsync:    true,
    logFn:        (msg) => systemLogger.debug('[session-store] ' + msg),
    fallbackToMemory: false,
    fileExtension: '.json'
  });
  activeSessionIsReapable = !useBuiltInReaper;
  systemLogger.info(sharedNotice);
  return store;
}

function buildRedisStore() {
  if (!RedisStore || !Redis) {
    systemLogger.error('[session] SESSION_MODE=redis but connect-redis / ioredis packages are missing. Run: npm install connect-redis ioredis');
    return buildFileStore({ useBuiltInReaper: true, sharedNotice: '[session] Falling back to single-server file store (Redis packages missing).' });
  }
  try {
    const redisClient = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null, enableReadyCheck: false })
      : new Redis({
          host:     process.env.REDIS_HOST,
          port:     parseInt(process.env.REDIS_PORT) || 6379,
          username: process.env.REDIS_USERNAME || undefined,
          password: process.env.REDIS_PASSWORD || undefined,
          db:       parseInt(process.env.REDIS_DB) || 0,
          tls:      process.env.REDIS_TLS === 'true' ? {} : undefined,
          lazyConnect: true,
          maxRetriesPerRequest: null,
          enableReadyCheck: false
        });
    redisClient.on('error', (err) => systemLogger.error('[session] Redis client error', { error: err.message }));
    redisClient.on('ready', ()    => systemLogger.info('[session] Redis session store connected'));
    redisClient.connect().catch((err) => systemLogger.warn('[session] Redis initial connect deferred', { error: err.message }));

    activeSessionIsReapable = false;
    systemLogger.info(`[session] mode=redis (${process.env.REDIS_HOST || process.env.REDIS_URL}) — sessions shared via Redis.`);
    return new (RedisStore)({
      client: redisClient,
      prefix: process.env.REDIS_PREFIX || 'wiki:sess:',
      ttl:    SESSION_TTL_SECS
    });
  } catch (err) {
    systemLogger.error('[session] Failed to initialise Redis store, falling back to single-server file store', { error: err.message });
    return buildFileStore({ useBuiltInReaper: true, sharedNotice: '[session] Redis init failed — sessions will NOT be shared between instances.' });
  }
}

function buildSessionStore() {
  switch (SESSION_MODE) {
    case SESSION_MODE_ENUM.REDIS:
      return buildRedisStore();
    case SESSION_MODE_ENUM.SYNCTHING:
      return buildFileStore({
        useBuiltInReaper: false,
        sharedNotice:
          `[session] mode=syncthing — sessions folder "${SESSIONS_DIR}" must be inside DATA_DIR and synced by SyncThing, ` +
          'built-in reaper is DISABLED (reap once globally via POST /api/maintenance/expire-sessions ' +
          'from ONE nominated server). Also ensure your load balancer enables STICKY SESSIONS ' +
          '(source-IP affinity or cookie) to minimise session-file race writes during SyncThing lag.'
      });
    case SESSION_MODE_ENUM.SINGLE:
    default:
      return buildFileStore({
        useBuiltInReaper: true,
        sharedNotice:
          '[session] mode=single — local file store with built-in reaper. ' +
          'Sessions will NOT be shared between instances. ' +
          `To enable multi-server sharing: set SESSION_MODE=syncthing (and sync DATA_DIR="${DATA_DIR}") or SESSION_MODE=redis.`
      });
  }
}

activeSessionStore = buildSessionStore();

function _expireSessionsNow() {
  return new Promise((resolve) => {
    if (!activeSessionIsReapable) {
      resolve({ ok: false, reason: 'Active session store does not use external reaping (Redis or built-in reaper enabled). No-op.' });
      return;
    }
    if (typeof activeSessionStore.reap !== 'function') {
      resolve({ ok: false, reason: 'session-file-store reap() API not available in this version.' });
      return;
    }
    activeSessionStore.reap((err) => {
      if (err) resolve({ ok: false, reason: err.message || String(err) });
      else     resolve({ ok: true,  reason: 'Reap cycle invoked via session-file-store.reap().' });
    });
  });
}

app.use(session({
  store: activeSessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECS * 1000
  }
}));

// ─── Flash + Passport ──────────────────────────────────────────────────────────
app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// ─── LDAP Strategy ─────────────────────────────────────────────────────────────
passport.use(new LdapStrategy({
  server: {
    url:            process.env.LDAP_URL            || 'ldap://your-domain-controller',
    bindDN:         process.env.LDAP_BIND_DN        || '',
    bindCredentials: process.env.LDAP_BIND_PASSWORD || '',
    searchBase:     process.env.LDAP_BASE_DN        || 'dc=example,dc=com',
    searchFilter:   process.env.LDAP_SEARCH_FILTER  || '(sAMAccountName={{username}})',
    searchAttributes: ['displayName', 'mail', 'sAMAccountName', 'cn', 'memberOf'],
    reconnect: true,
    tlsOptions: {
      rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false'
    }
  }
}));

// ─── Password helpers (Node scrypt — no native deps) ──────────────────────────
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf  = crypto.scryptSync(password, salt, KEYLEN, SCRYPT_PARAMS).toString('hex');
  return `scrypt$16384$8$1$${salt}$${buf}`;
}
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const [, Ns, rs, ps, salt, hex] = parts;
    const params = {
      N: parseInt(Ns, 10), r: parseInt(rs, 10), p: parseInt(ps, 10),
      maxmem: 64 * 1024 * 1024
    };
    const derived = crypto.scryptSync(password, salt, KEYLEN, params);
    const expected = Buffer.from(hex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}

// ─── Local Strategy (password-based accounts stored in users.json) ─────────────
passport.use(new LocalStrategy({
  usernameField: 'username',
  passwordField: 'password'
}, (username, password, done) => {
  try {
    const registry = loadUsers();
    const record = registry[username];
    if (!record || !record.passwordHash) {
      // No such local account — LDAP strategy is tried next in the login chain
      return done(null, false);
    }
    if (!verifyPassword(password, record.passwordHash)) {
      return done(null, false);
    }
    const now = new Date().toISOString();
    // Use mutex helper (best-effort sync since we're inside callback)
    const update = () => {
      const r = loadUsers();
      if (r[username]) {
        r[username].lastLoginAt = now;
        saveUsers(r);
      }
    };
    if (!_userLock.busy) {
      _userLock.busy = true;
      try { update(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); }
    } else {
      _userLock.queue.push(() => { try { update(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); }});
    }
    return done(null, { ...record, source: record.source || 'local' });
  } catch (err) {
    return done(err);
  }
}));

// LDAP users are serialized WITH their role so it's available in req.user
// without hitting the disk on every request.
passport.serializeUser((user, done) => {
  // Local admin path: role is pre-set on the user object
  if (user._localAdmin) {
    return done(null, {
      username:    user.username,
      displayName: user.displayName,
      email:       '',
      role:        'administrator',
      _localAdmin: true
    });
  }
  // Local-password-account path: record already has role/displayName/email
  if (user.passwordHash || user.source === 'local' || user.source === 'hybrid') {
    return done(null, {
      username:    user.username,
      displayName: user.displayName || user.username || 'User',
      email:       user.email || '',
      role:        user.role || 'reader',
      avatar:      user.avatar || null
    });
  }
  // LDAP path: pull role from registry
  const username = user.sAMAccountName || user.cn || user.uid || '';
  const registry = loadUsers();
  const record   = registry[username];
  done(null, {
    username,
    displayName: user.displayName || user.cn || username || 'User',
    email:       user.mail || '',
    role:        record ? record.role : 'reader'
  });
});

// Re-hydrate the role on every request so:
//  a) stale sessions (no role field) work correctly
//  b) role changes take effect immediately without needing a re-login
passport.deserializeUser((sessionUser, done) => {
  // Local admin is never in the registry; always gets administrator.
  // Refresh displayName / email / avatar from the registry so that profile
  // updates take effect immediately without requiring a re-login.
  if (sessionUser._localAdmin) {
    try {
      const registry   = loadUsers();
      const envUsername = process.env.LOCAL_ADMIN_USERNAME;
      const rec        = envUsername ? registry[envUsername] : null;
      const avatar     = rec?.avatar || null;
      const displayName = rec?.displayName || sessionUser.displayName;
      const email       = rec?.email || sessionUser.email || '';
      return done(null, { ...sessionUser, role: 'administrator', displayName, email, avatar });
    } catch {
      return done(null, { ...sessionUser, role: 'administrator' });
    }
  }
  // For LDAP/local/hybrid users, refresh role + avatar from the on-disk registry
  try {
    const registry = loadUsers();
    const record   = registry[sessionUser.username];
    const role     = record ? record.role : (sessionUser.role || 'reader');
    const avatar   = record ? (record.avatar || null) : null;
    done(null, { ...sessionUser, role, avatar });
  } catch {
    done(null, { ...sessionUser, role: sessionUser.role || 'reader' });
  }
});

// ─── Hierarchy helpers ─────────────────────────────────────────────────────────

/** Build a nested tree from a flat page array, sorted by position then title. */
function buildTree(pages) {
  const map = {};
  pages.forEach(p => { map[p.slug] = { ...p, children: [] }; });
  const roots = [];
  pages.forEach(p => {
    if (p.parent && map[p.parent]) map[p.parent].children.push(map[p.slug]);
    else roots.push(map[p.slug]);
  });
  const sort = nodes => {
    nodes.sort((a, b) => ((a.position ?? 9999) - (b.position ?? 9999)) || a.title.localeCompare(b.title));
    nodes.forEach(n => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Ordered [root … direct-parent] ancestor array for a given slug. */
function getAncestors(slug, pages) {
  const map = {};
  pages.forEach(p => { map[p.slug] = p; });
  const ancestors = [];
  let cur = map[slug];
  while (cur && cur.parent && map[cur.parent]) {
    cur = map[cur.parent];
    ancestors.unshift(cur);
  }
  return ancestors;
}

/** Set of all descendant slugs — used to prevent cycles in parent selection. */
function getDescendants(slug, pages) {
  const result = new Set();
  const add = s => pages.filter(p => p.parent === s).forEach(p => { result.add(p.slug); add(p.slug); });
  add(slug);
  return result;
}

/** Depth-annotated flat list suitable for rendering the sidebar tree. */
function flattenTree(nodes, depth = 0) {
  const out = [];
  nodes.forEach(n => {
    out.push({ ...n, depth, hasChildren: n.children.length > 0 });
    if (n.children.length) out.push(...flattenTree(n.children, depth + 1));
  });
  return out;
}

/** Flat list with indent depth for <select> parent dropdowns. */
function flattenForSelect(nodes, depth = 0) {
  const out = [];
  nodes.forEach(n => {
    out.push({ slug: n.slug, title: n.title, depth });
    if (n.children.length) out.push(...flattenForSelect(n.children, depth + 1));
  });
  return out;
}

// ─── Global view locals (runs BEFORE any middleware that may render a page) ────
// Order matters: CSRF-enforcement, 404-handlers, error-views, and routes all
// read `res.locals.user / flash / nav*`, so this middleware must come first.
//
// Also sets Cache-Control for authenticated HTML/browser responses so flash
// messages (consumed in res.locals.flash above) are never "left over" due to a
// stale 304 browser-cached response that never ran this middleware: without
// this a POST save → 302 redirect → browser serves cached 304 HTML → the
// res.locals.flash read above is SKIPPED (no server request) and the flash
// message silently leaks onto the *next* page the user actually navigates to
// (causing the classic "green bar on wrong page" complaint).
app.use((req, res, next) => {
  res.locals.user  = req.user || null;
  res.locals.flash = { error: req.flash('error'), success: req.flash('success'), info: req.flash('info') };
  res.locals.settings = loadSettings();
  res.locals.navFlat  = [];
  res.locals.navPages = [];
  if (req.isAuthenticated()) {
    try {
      const pages = listPages();
      res.locals.navPages = pages;
      res.locals.navFlat  = flattenTree(buildTree(pages));
    } catch { /* ignore */ }
    // Authenticated pages may contain user-specific content + flash banners.
    // Disable HTTP caching entirely for them so 304s never skip flash
    // consumption and stale content never misleads the user.
    if (!req.headers.accept || /html/i.test(req.headers.accept) || req.accepts('html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
  // Wrap res.redirect on POST/PUT/PATCH (state-changing) to append a tiny
  // cache-busting nonce query param. This guarantees that even if some
  // misconfigured layer (CDN, service worker, corporate proxy) ignores our
  // Cache-Control headers above, the browser hits the server fresh on the
  // redirect target and does not surface a cached 304 that skipped flash
  // consumption. URLs already with query strings are preserved.
  const origRedirect = res.redirect.bind(res);
  res.redirect = function (statusOrUrl, maybeUrl) {
    const code = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
    const url  = typeof statusOrUrl === 'number' ? (maybeUrl || '/') : (statusOrUrl || '/');
    let busted = url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const sep = url.includes('?') ? '&' : '?';
      busted = `${url}${sep}_t=${Date.now()}`;
    }
    return origRedirect(code, busted);
  };
  next();
});

// ─── CSRF token injection into res.locals (per request, for view rendering) ───
// csrfToken(req, res, next) internally:
//   * Reuses any session token when present (fast, sync path).
//   * Lazy-generates + saves a new token to the session store ONLY on first
//     use (async path). It invokes `next()` ONLY AFTER both steps finish,
//     so downstream code + EJS views always see a defined `res.locals.csrfToken`
//     (string, never undefined).
// We used to call `csrfToken(req, res, ()=>{})` with a noop then `next()`
// immediately — that bypassed the async save barrier and produced
// `ReferenceError: csrfToken is not defined` in the layout template.
app.use((req, res, next) => {
  try {
    csrfToken(req, res, next);
  } catch {
    // csrf-sync can throw when no session exists yet on public routes.
    // Even on total failure we emit a non-empty manual token string so views
    // that render <input _csrf> unguarded never submit empty, and never
    // throw ReferenceError.
    let fb = '';
    try { fb = _manualFreshCsrf(); } catch { fb = 'csrf_fallback_' + Date.now(); }
    res.locals.csrfToken = fb;
    next();
  }
});

// ─── Enforce CSRF on all state-changing requests (POST / PUT / DELETE / PATCH) ─
// csrf-sync's middleware reports failure via next(createHttpError(...)) rather
// than throw; our wrapper catches BOTH paths to render a friendly 403 page.
function _renderCsrfError(req, res, csrfErr, diag) {
  systemLogger.warn('CSRF token validation failed', {
    method: req.method, path: req.path, ip: req.ip,
    user: req.user?.username || '(unauthenticated)',
    error: csrfErr?.message || String(csrfErr)
  });
  const diags = diag && (process.env.NODE_ENV !== 'production') ? [
    `<details style="margin:0.5rem 0 1rem;padding:1rem;border:1px solid var(--c-border-muted);border-radius:var(--r);white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:0.82rem;background:var(--c-bg-overlay)"><summary style="cursor:pointer;color:var(--c-muted)">CSRF diagnostics (dev-only)</summary>${
      JSON.stringify({
        submitted:   (diag.submittedLen ? `len=${diag.submittedLen} sha=${diag.submittedSha}` : 'EMPTY/MISSING') + ` @ source=${diag.submittedSrc}`,
        expected:    diag.expectedLen  ? `len=${diag.expectedLen} sha=${diag.expectedSha}`  : 'NONE (session has no token yet — try refreshing)',
        match:       diag.match,
        hasSession:  diag.hasSession,
        userAgent:   req.headers?.['user-agent'] || ''
      }, null, 2)
    }</details>`
  ].join('') : '';
  try {
    res.status(403).render('error', {
      title: '403 Forbidden', statusCode: 403,
      user:     res.locals.user     || null,
      flash:    res.locals.flash    || { error: [], success: [], info: [] },
      navFlat:  res.locals.navFlat  || [],
      navPages: res.locals.navPages || [],
      csrfToken: res.locals.csrfToken || '',
      message: 'Request rejected: invalid or missing CSRF token. Please go back, refresh the page, and try again.' + diags
    });
  } catch (renderErr) {
    systemLogger.error('CSRF 403 render failed — falling back to plain text', {
      renderError: renderErr?.message || String(renderErr)
    });
    res.status(403).type('text/plain').send(
      '403 Forbidden — invalid or missing CSRF token.\r\n' +
      'Please go back, refresh the page, and try again.\r\n' +
      '\r\n' +
      'If this continues, clear your browser cookies for this site and log in again.'
    );
  }
}
function _sha(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12); }
function _csrfSrc(req) {
  try {
    if (typeof req.headers['x-csrf-token'] === 'string' && req.headers['x-csrf-token']) return 'header(x-csrf-token)';
  } catch {}
  try { if (req.body?._csrf) return 'body._csrf'; } catch {}
  try { if (req.query?._csrf) return 'query._csrf'; } catch {}
  return 'none';
}
app.use((req, res, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();

  // ── CSRF exemptions (industry standard + implementation constraints) ──
  // • POST /login: login forms are protected by TLS + sameSite cookies +
  //   password knowledge, and saveUninitialized:false means no session
  //   exists on the first GET/POST of the login handshake — so a CSRF
  //   token literally cannot be stored/retrieved until after the login
  //   succeeds and session.regenerate() runs.  Always allow.
  if (req.method === 'POST' && req.path === '/login') return next();

  // • POST /uploads (multipart/form-data): the hidden _csrf field cannot be
  //   parsed by express.urlencoded so route-local check runs after multer.
  const ct = req.headers['content-type'] || '';
  if (req.method === 'POST' && req.path === '/uploads' && /^multipart\/form-data/i.test(ct)) return next();

  // Diagnostic: capture submitted/expected hashes BEFORE csrf-sync runs.
  let submitted, submittedRaw, submittedSrc, expected;
  try { submitted = getTokenFromRequest(req); } catch { submitted = undefined; }
  // submittedRaw captures the raw comma-concatenated 513-byte mess for
  // diagnostics (dev-only); the parsed `submitted` (first plausible token)
  // is what csrf-sync actually uses for verification. This way warnings
  // display both the sanitized submittedLen and the original raw length
  // so we can instantly tell if a duplicate-input comma merge happened.
  try {
    submittedRaw = (req.body?._csrf !== undefined) ? String(req.body._csrf)
                 : (req.headers?.['x-csrf-token'] !== undefined) ? String(req.headers['x-csrf-token'])
                 : (req.query?._csrf !== undefined) ? String(req.query._csrf) : '';
  } catch { submittedRaw = ''; }
  submittedSrc = _csrfSrc(req);
  try { expected = getTokenFromState(req); } catch { expected = undefined; }
  const diag = {
    method: req.method, path: req.path, user: (req.user && req.user.username) || null, ip: req.ip,
    submittedSha: _sha(submitted), submittedSrc,
    submittedLen: submitted ? String(submitted).length : 0,
    submittedRawLen: submittedRaw ? submittedRaw.length : 0,
    submittedRawCommas: (submittedRaw.match(/,/g) || []).length,
    expectedSha: _sha(expected),  expectedLen: expected ? String(expected).length : 0,
    match: !!submitted && !!expected && String(submitted) === String(expected),
    hasSession: Boolean(req.session && req.session.id)
  };

  const wrappedNext = (err) => {
    if (err) {
      // Always emit a WARN-level diagnostic on ANY CSRF failure so admins can
      // disambiguate: "missing submitted token" vs "stale form (browser tab
      // open before server restart / cookie clear)" vs "session not loaded".
      diag.error = (err && err.message) || 'EBADCSRF';
      systemLogger.warn('CSRF token validation failed', diag);
      _renderCsrfError(req, res, err, diag);
      return;
    }
    next();
  };
  try {
    csrfSynchronisedProtection(req, res, wrappedNext);
  } catch (err) {
    diag.error = (err && err.message) || 'CSRF_MW_THREW';
    logger.warn('CSRF token validation failed', diag);
    _renderCsrfError(req, res, err, diag);
  }
});

// ─── Sanitize-html defaults: allow rich wiki content but block scripts/forms ──
const SANITIZE_OPTS = {
  allowedTags: [
    'h1','h2','h3','h4','h5','h6','p','br','hr','span','div',
    'strong','b','em','i','u','s','strike','sub','sup','blockquote','pre','code',
    'ul','ol','li','dl','dt','dd',
    'a','img',
    'table','thead','tbody','tr','th','td','caption','colgroup','col',
    'figure','figcaption','abbr','acronym','address','bdo','big','small','cite','q','del','ins','kbd','samp','var','tt'
  ],
  allowedAttributes: {
    '*':    ['class','style','id','title','dir','lang'],
    'a':    ['href','target','rel','name','download'],
    'img':  ['src','alt','title','width','height','loading'],
    'td':   ['colspan','rowspan','align','valign'],
    'th':   ['colspan','rowspan','align','valign','scope'],
    'tr':   ['align','valign'],
    'code': ['class'],
    'pre':  ['class']
  },
  allowedSchemes: ['http','https','ftp','mailto','tel','data'],
  allowedSchemesAppliedToAttributes: ['href','src','cite'],
  allowProtocolRelative: true,
  enforceHtmlBoundary: false,
  disallowedTagsMode: 'recursiveEscape',
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true }
};

// ─── URL Normalization: always store media paths as server-absolute `/uploads/…` ─
const UPLOAD_URL_PREFIX    = '/uploads/';
const AVATAR_URL_PREFIX    = '/avatars/';
const PAGES_URL_PREFIX_RE  = /^\.{1,3}\/+(?:pages\/+)?|^\/+(?:pages\/+)+/i;
function _resolveRelPath(rel, baseDepth) {
  if (!rel) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rel)) return null;
  if (rel.startsWith('//')) return null;
  if (rel.startsWith('/')) {
    const m = rel.match(/^\/+(uploads|avatars|pages)\/+(.*)$/i);
    if (m) return { type: m[1].toLowerCase(), name: m[2].split('#')[0].split('?')[0] };
    return null;
  }
  let clean = rel.replace(/\\/g, '/');
  clean = clean.split('#')[0].split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  const stack = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  if (!stack.length) return null;
  const joined = stack.join('/');
  for (let d = baseDepth; d >= 0; d--) {
    const slice = stack.slice(0, Math.min(stack.length, 2 - d + 1));
    if (slice.length >= 2) {
      const first = slice[0]?.toLowerCase();
      if (first === 'uploads') return { type: 'uploads', name: stack.slice(1).join('/') };
      if (first === 'avatars') return { type: 'avatars', name: stack.slice(1).join('/') };
    }
  }
  if (joined.match(/\.(png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|pptx?|txt|csv|zip|7z|rar)$/i)) {
    return { type: 'uploads', name: stack[stack.length - 1] };
  }
  return null;
}
function _normalizeUploadUrls(html) {
  if (!html || typeof html !== 'string') return '';
  const tmp = sanitizeHtml(html, SANITIZE_OPTS);
  const ATTR_RE = /\s([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
  return tmp.replace(/<(a|img)\b([^>]*)>/gi, function (match, tag, attrsRaw) {
    const attrName = tag.toLowerCase() === 'a' ? 'href' : 'src';
    const attrs = [];
    const seen = new Set();
    let m;
    let before = ' ' + attrsRaw + ' ';
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(attrsRaw)) !== null) {
      const name = (m[1] || '').toLowerCase();
      if (!name) continue;
      const value = m[2] !== undefined ? m[2]
                 : m[3] !== undefined ? m[3]
                 : m[4] !== undefined ? m[4] : '';
      // Skip the href/src we'll replace, and dedupe malformed duplicates
      if (name === attrName) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const safe = String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      attrs.push(`${name}="${safe}"`);
    }
    // Now re-extract the original url for href/src
    const QD = '(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]*))';
    const oldPattern = '(?:^|\\s)' + attrName + '\\s*=\\s*' + QD;
    const oldM = attrsRaw.match(new RegExp(oldPattern, 'i'));
    let url = null;
    if (oldM) {
      for (let i = 1; i <= 3; i++) { if (typeof oldM[i] === 'string') { url = oldM[i]; break; } }
    }
    if (url === null) return match;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//')) return match;
    let resolved;
    if (url.startsWith('/')) {
      const um = url.match(/^\/+(uploads|avatars|pages)\/+([^#?]*)/i);
      if (!um) return match;
      const [, type, name] = um;
      resolved = `/${type.toLowerCase()}/${decodeURIComponent(name)}`;
    } else {
      const rel = _resolveRelPath(url, 1);
      if (!rel) return match;
      const type = rel.type === 'uploads' ? 'uploads'
                 : rel.type === 'avatars' ? 'avatars'
                 : rel.type === 'pages'   ? 'pages'
                 : null;
      if (!type) return match;
      resolved = `/${type}/${rel.name}`;
    }
    const safeUrl = resolved
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    attrs.unshift(`${attrName}="${safeUrl}"`);
    return `<${tag} ${attrs.join(' ')}>`;
  });
}

function sanitizeContent(html) {
  if (!html || typeof html !== 'string') return '';
  return _normalizeUploadUrls(sanitizeHtml(html, SANITIZE_OPTS));
}

// ─── Resolve-and-validate helper: guarantee paths stay inside a base directory ─
function assertWithinBaseDir(filename, baseDir) {
  const clean = String(filename || '').replace(/^\.\.([/\\]|$)/, '').replace(/^[/\\]+/, '');
  const candidate = path.resolve(baseDir, clean);
  const base = path.resolve(baseDir);
  if (!candidate.startsWith(base + path.sep) && candidate !== base) return null;
  return candidate;
}

// ─── Auth guard ────────────────────────────────────────────────────────────────
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

/**
 * Role guard factory. `minRole` is the minimum role required.
 * Role hierarchy: reader < editor < administrator
 */
const ROLE_RANK = { reader: 0, editor: 1, administrator: 2 };
function ensureRole(minRole) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    const userRank = ROLE_RANK[req.user.role] ?? 0;
    const reqRank  = ROLE_RANK[minRole] ?? 0;
    if (userRank >= reqRank) return next();
    try {
      res.status(403).render('error', {
        title: '403 Forbidden', statusCode: 403,
        user:     res.locals.user     || null,
        flash:    res.locals.flash    || { error: [], success: [], info: [] },
        navFlat:  res.locals.navFlat  || [],
        navPages: res.locals.navPages || [],
        csrfToken: res.locals.csrfToken || '',
        message: `You need ${minRole} access to perform this action.`
      });
    } catch (renderErr) {
      systemLogger.error('ensureRole 403 render failed — plain-text fallback', {
        renderError: renderErr?.message || String(renderErr)
      });
      res.status(403).type('text/plain').send(
        `403 Forbidden — you need ${minRole} access to perform this action.`
      );
    }
  };
}

// ─── Page helpers ──────────────────────────────────────────────────────────────
function loadPage(slug) {
  const file = path.join(PAGES_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  try { return fs.readJsonSync(file); } catch { return null; }
}

function savePage(data) {
  fs.writeJsonSync(path.join(PAGES_DIR, `${data.slug}.json`), data, { spaces: 2 });
}

// ─── Atomic JSON write helper (temp file + rename avoids corruption) ───────────
function writeJsonAtomic(targetPath, data) {
  const dir      = path.dirname(targetPath);
  const base     = path.basename(targetPath);
  const tmp      = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, targetPath);
}

// ─── User registry helpers ─────────────────────────────────────────────────────
function loadUsers() {
  try { return fs.readJsonSync(USERS_FILE); } catch { return {}; }
}
function saveUsers(data) {
  writeJsonAtomic(USERS_FILE, data);
}
/**
 * Register a new user with role 'reader', or update lastLoginAt for an existing one.
 * Never changes the role on subsequent logins.
 * Uses an in-process lock + atomic write to prevent lost updates under concurrent logins.
 */
const _userLock = { busy: false, queue: [] };
function upsertUser({ username, displayName, email }) {
  const now = new Date().toISOString();
  const apply = () => {
    const registry = loadUsers();
    if (!registry[username]) {
      registry[username] = { username, displayName, email, role: 'reader', source: 'ldap', registeredAt: now, lastLoginAt: now };
    } else {
      registry[username].lastLoginAt  = now;
      registry[username].displayName  = displayName || registry[username].displayName;
      registry[username].email        = email        || registry[username].email;
      if (!registry[username].source) registry[username].source = registry[username].passwordHash ? 'hybrid' : 'ldap';
    }
    saveUsers(registry);
    return registry[username];
  };
  if (!_userLock.busy) {
    _userLock.busy = true;
    try { return apply(); }
    finally {
      _userLock.busy = false;
      const next = _userLock.queue.shift();
      if (next) setImmediate(next);
    }
  }
  return new Promise(resolve => {
    _userLock.queue.push(() => {
      try { resolve(apply()); } finally {
        _userLock.busy = false;
        const nxt = _userLock.queue.shift();
        if (nxt) setImmediate(nxt);
      }
    });
  });
}

// SyncThing creates conflict copies named like: slug.sync-conflict-20260902-DEVICEID.json
// We must filter them out so they never appear as real wiki pages.
const SYNCTHING_CONFLICT_RE = /\.sync-conflict-/;

function listPages() {
  return fs.readdirSync(PAGES_DIR)
    .filter(f => f.endsWith('.json') && !SYNCTHING_CONFLICT_RE.test(f))
    .map(f => { try { return fs.readJsonSync(path.join(PAGES_DIR, f)); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ─── Upload helpers ─────────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.txt', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.zip', '.7z', '.rar'
];

// ─── Avatar helpers ──────────────────────────────────────────────────────────
const AVATAR_ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
function avatarUrlFor(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const clean = String(filename).replace(/\0/g, '');
  const ext = path.extname(clean).toLowerCase();
  if (!AVATAR_ALLOWED_EXT.includes(ext)) return null;
  return `/avatars/${encodeURIComponent(clean)}`;
}

function fileIcon(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.pdf': '📄', '.doc': '📝', '.docx': '📝',
    '.xls': '📊', '.xlsx': '📊', '.csv': '📊',
    '.ppt': '📋', '.pptx': '📋',
    '.txt': '📃',
    '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
    '.zip': '🗜️', '.7z': '🗜️', '.rar': '🗜️'
  })[ext] || '📎';
}

function formatBytes(bytes) {
  if (bytes < 1024)              return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listUploads() {
  return fs.readdirSync(UPLOADS_DIR)
    .filter(f => !f.startsWith('.') && !SYNCTHING_CONFLICT_RE.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      return {
        name:         f,
        originalName: f.replace(/^\d+_/, ''),
        size:         formatBytes(stat.size),
        sizeRaw:      stat.size,
        uploadedAt:   stat.birthtime,
        icon:         fileIcon(f),
        ext:          path.extname(f).toLowerCase()
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

// ─── Multer ─────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`File type "${ext}" is not permitted.`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Authentication ────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('login', { title: 'Sign In — OnlineWiki', layout: false, csrfToken: res.locals.csrfToken });
});

// ─── Local admin credentials (optional fallback, set in .env) ────────────────
// Uses constant-time comparison to prevent timing-based password leaks.
function localAdminMatch(username, password) {
  const envUser = process.env.LOCAL_ADMIN_USERNAME;
  const envPass = process.env.LOCAL_ADMIN_PASSWORD;
  if (!envUser || !envPass) return false;                     // not configured
  if (!username || !password) return false;
  // timingSafeEqual requires identical buffer lengths
  try {
    const uMatch = envUser.length === username.length &&
      crypto.timingSafeEqual(Buffer.from(envUser), Buffer.from(username));
    const pMatch = envPass.length === password.length &&
      crypto.timingSafeEqual(Buffer.from(envPass), Buffer.from(password));
    return uMatch && pMatch;
  } catch { return false; }
}

app.post('/login', (req, res, next) => {
  const { username, password } = req.body;

  // ── 1. Local admin (env-configured fallback) ───────────────────────────
  if (localAdminMatch(username, password)) {
    const localUser = {
      username:    process.env.LOCAL_ADMIN_USERNAME,
      displayName: process.env.LOCAL_ADMIN_DISPLAY_NAME || 'Local Administrator',
      email:       '',
      role:        'administrator',
      _localAdmin: true
    };
    const returnTo = req.session.returnTo || '/';
    return req.session.regenerate(regenErr => {
      if (regenErr) { systemLogger.error('Session regenerate error', { error: regenErr.message }); return next(regenErr); }
      req.logIn(localUser, loginErr => {
        if (loginErr) { systemLogger.error('Local admin login error', { error: loginErr.message }); return next(loginErr); }
        req.session.save(saveErr => {
          if (saveErr) systemLogger.warn('Session save error after local login', { error: saveErr.message });
          auditLogger.info('USER_LOGIN', { username: localUser.username, displayName: localUser.displayName, role: 'administrator', method: 'env-admin', ip: req.ip });
          res.redirect(returnTo);
        });
      });
    });
  }

  // ── 2. Local password accounts (stored in users.json) ──────────────────
  return passport.authenticate('local', (err, user, info) => {
    if (err) {
      systemLogger.error('Local account authentication error', { error: err.message, ip: req.ip });
      req.flash('error', 'An authentication error occurred. Please contact your administrator.');
      return res.redirect('/login');
    }
    if (user) {
      const returnTo = req.session.returnTo || '/';
      return req.session.regenerate(regenErr => {
        if (regenErr) { systemLogger.error('Session regenerate error', { error: regenErr.message }); return next(regenErr); }
        req.logIn(user, loginErr => {
          if (loginErr) { systemLogger.error('Local account session login error', { error: loginErr.message }); return next(loginErr); }
          req.session.save(saveErr => {
            if (saveErr) systemLogger.warn('Session save error after local account login', { error: saveErr.message });
            auditLogger.info('USER_LOGIN', { username: user.username, displayName: user.displayName || user.username, role: user.role, method: 'local-account', ip: req.ip });
            res.redirect(returnTo);
          });
        });
      });
    }

    // ── 3. LDAP / Active Directory ──────────────────────────────────────
    passport.authenticate('ldapauth', (ldapErr, ldapUser, ldapInfo) => {
      if (ldapErr) {
        systemLogger.error('LDAP authentication error', { error: ldapErr.message, ip: req.ip });
        req.flash('error', 'An authentication error occurred. Please contact your administrator.');
        return res.redirect('/login');
      }
      if (!ldapUser) {
        systemLogger.warn('Failed login attempt', { username: req.body.username, ip: req.ip });
        req.flash('error', 'Invalid username or password. Please try again.');
        return res.redirect('/login');
      }
      const ldapUsername = ldapUser.sAMAccountName || ldapUser.cn || ldapUser.uid || '';
      Promise.resolve(upsertUser({
        username:    ldapUsername,
        displayName: ldapUser.displayName || ldapUser.cn || ldapUsername,
        email:       ldapUser.mail || ''
      })).then(record => {
        ldapUser._role = record.role;
        req.logIn(ldapUser, loginErr => {
          if (loginErr) { systemLogger.error('Session login error', { error: loginErr.message }); return next(loginErr); }
          auditLogger.info('USER_LOGIN', { username: ldapUsername, displayName: record.displayName, role: record.role, method: 'ldap', ip: req.ip });
          const returnTo = req.session.returnTo || '/';
          delete req.session.returnTo;
          res.redirect(returnTo);
        });
      }).catch(next);
    })(req, res, next);
  })(req, res, next);
});

app.post('/logout', ensureAuth, (req, res) => {
  const u = req.user;
  req.logout(() => {
    auditLogger.info('USER_LOGOUT', { username: u?.username, ip: req.ip });
    res.redirect('/login');
  });
});

// ─── Home ──────────────────────────────────────────────────────────────────────
app.get('/', ensureAuth, (req, res) => {
  const pages = listPages();
  const tree  = buildTree(pages);
  // Annotate each sibling list (roots + any rendered child levels) with
  // _canMoveUp/_canMoveDown so editors can reorder directly from the home view.
  // Safe because buildTree() returns fresh spread objects, not the page records.
  (function annotateSiblings(list) {
    list.forEach((n, i, arr) => {
      n._canMoveUp   = i > 0;
      n._canMoveDown = i >= 0 && i < arr.length - 1;
      if (Array.isArray(n.children) && n.children.length) annotateSiblings(n.children);
    });
  })(tree);
  res.render('home', { title: 'Wiki Home — OnlineWiki', pages, tree, csrfToken: res.locals.csrfToken });
});

// ─── Pages — IMPORTANT: /pages/new must come before /pages/:slug ──────────────
app.get('/pages/new', ensureRole('editor'), (req, res) => {
  const pages       = listPages();
  const tree        = buildTree(pages);
  const selectPages = flattenForSelect(tree);
  const presetParent = (req.query.parent || '').trim();
  const existingTitles = pages.map(p => ({ title: p.title, slug: p.slug }));
  res.render('edit', { title: 'New Page — OnlineWiki', page: null, isNew: true, selectPages, presetParent, existingTitles, csrfToken: res.locals.csrfToken });
});

app.post('/pages/new', ensureRole('editor'), (req, res) => {
  const title    = (req.body.title   || '').trim();
  const rawSlug  = (req.body.slug    || title).trim();
  const content  = sanitizeContent(req.body.content || '');
  const tags     = (req.body.tags    || '').split(',').map(t => t.trim()).filter(Boolean);
  const parent   = (req.body.parent  || '').trim() || null;
  const confirmDuplicate = (req.body.confirmDuplicate || '').toString().toLowerCase() === 'true';

  const slug = slugify(rawSlug, { lower: true, strict: true });

  if (!title || !slug) {
    req.flash('error', 'Title and slug are required.');
    return res.redirect('/pages/new');
  }

  // Title-duplicate guard — case-insensitive match against any other page.
  const allPages = listPages();
  const dupTitleMatch = allPages.find(p => p.title && p.title.toLowerCase() === title.toLowerCase());
  if (dupTitleMatch && !confirmDuplicate) {
    req.flash('error',
      `Another page titled "${dupTitleMatch.title}" already exists (slug: ${dupTitleMatch.slug}). ` +
      `Confirm the save again if you want to proceed with a duplicate title.`);
    return res.redirect('/pages/new');
  }

  // Slug collision handling: since the filesystem requires unique slugs but
  // we intentionally allow duplicate titles, a title duplicate whose slug
  // collides with an existing page (e.g. two pages titled "Hello World" →
  // slugify both → "hello-world") must not silently refuse to create the
  // second page after the user already confirmed the duplicate title.
  // Instead, auto-derive a unique slug by appending -2, -3, … until we find
  // a free one.  This matches the user's confirmation intent (they said
  // "Yes, keep the duplicate title") while keeping the filesystem invariant
  // that slugs are unique.
  let candidateSlug = slug;
  let suffix = 1;
  while (loadPage(candidateSlug)) {
    suffix += 1;
    candidateSlug = `${slug}-${suffix}`;
  }
  if (candidateSlug !== slug) {
    systemLogger.info('Slug auto-deduplicated', { from: slug, to: candidateSlug, requestedTitle: title, ip: req.ip, user: req.user?.username });
    req.flash('info', `The title "${title}" is shared with another page; auto-assigned slug "/pages/${candidateSlug}" to avoid conflicts.  You can change it later via Edit → Slug.`);
  }
  const finalSlug = candidateSlug;
  // Validate parent exists (unless empty)
  if (parent && !loadPage(parent)) {
    req.flash('error', `Parent page "${parent}" does not exist.`);
    return res.redirect('/pages/new');
  }

  // Auto-assign position = number of existing siblings (append to end)
  const siblings = listPages().filter(p => (p.parent || null) === parent);
  const position = siblings.length;

  const now = new Date().toISOString();
  savePage({
    title, slug: finalSlug, content, tags, parent, position,
    author:        req.user.username,
    authorDisplay: req.user.displayName,
    createdAt: now, updatedAt: now,
    attachments: []
  });

  auditLogger.info('PAGE_CREATED', { slug: finalSlug, title, createdBy: req.user.username, ip: req.ip });
  req.flash('success', `Page "${title}" created successfully.`);
  res.redirect(`/pages/${finalSlug}`);
});

app.get('/pages/:slug', ensureAuth, (req, res) => {
  const page = loadPage(req.params.slug);
  if (!page) {
    return res.status(404).render('error', {
      title: '404 Not Found', statusCode: 404,
      user:     res.locals.user     || null,
      flash:    res.locals.flash    || { error: [], success: [], info: [] },
      navFlat:  res.locals.navFlat  || [],
      navPages: res.locals.navPages || [],
      csrfToken: res.locals.csrfToken || '',
      message: `The page "${req.params.slug}" does not exist.`
    });
  }
  const pages     = listPages();
  const tree      = buildTree(pages);
  const ancestors = getAncestors(req.params.slug, pages);
  // Direct children for the "In This Section" panel; annotate each with
  // per-child move-up/move-down flags so editors can reorder inline.
  const treeNode  = flattenTree(tree).find(n => n.slug === req.params.slug);
  const rawChildren = treeNode ? treeNode.children : [];
  const children  = rawChildren.map((c, i, arr) =>
    ({ ...c, _canMoveUp: i > 0, _canMoveDown: i >= 0 && i < arr.length - 1 }));
  // Siblings for move-up / move-down buttons
  const parentSlug = page.parent || null;
  const siblings   = pages
    .filter(p => (p.parent || null) === parentSlug)
    .sort((a, b) => ((a.position ?? 9999) - (b.position ?? 9999)) || a.title.localeCompare(b.title));
  const siblingIdx   = siblings.findIndex(s => s.slug === page.slug);
  const canMoveUp    = siblingIdx > 0;
  const canMoveDown  = siblingIdx >= 0 && siblingIdx < siblings.length - 1;
  // Enrich attachment metadata
  const attachments = (page.attachments || []).map(name => {
    const filePath = path.join(UPLOADS_DIR, name);
    const exists   = fs.existsSync(filePath);
    const stat     = exists ? fs.statSync(filePath) : null;
    return { name, originalName: name.replace(/^\d+_/, ''), exists, size: stat ? formatBytes(stat.size) : 'unknown', icon: fileIcon(name) };
  });
  res.render('page', { title: `${page.title} — OnlineWiki`, page, attachments, ancestors, children, canMoveUp, canMoveDown, csrfToken: res.locals.csrfToken });
});

app.get('/pages/:slug/edit', ensureRole('editor'), (req, res) => {
  let page = loadPage(req.params.slug);
  if (!page) {
    return res.status(404).render('error', {
      title: '404 Not Found', statusCode: 404,
      user:     res.locals.user     || null,
      flash:    res.locals.flash    || { error: [], success: [], info: [] },
      navFlat:  res.locals.navFlat  || [],
      navPages: res.locals.navPages || [],
      csrfToken: res.locals.csrfToken || '',
      message: `The page "${req.params.slug}" does not exist.`
    });
  }
  // Defence-in-depth: on load, re-normalize any legacy relative URLs so the
  // editor always receives absolute /uploads/… paths (images stay visible
  // regardless of current document URL depth).
  const normalized = sanitizeContent(page.content || '');
  if (normalized !== (page.content || '')) {
    page = Object.assign({}, page, { content: normalized });
    const persisted = loadPage(req.params.slug);
    if (persisted && persisted.content !== normalized) {
      persisted.content = normalized;
      savePage(persisted);
    }
  }
  const pages       = listPages();
  const tree        = buildTree(pages);
  const descendants = getDescendants(req.params.slug, pages);
  const selectPages = flattenForSelect(tree)
    .filter(p => p.slug !== req.params.slug && !descendants.has(p.slug));
  const presetParent = page.parent || '';
  const existingTitles = pages.map(p => ({ title: p.title, slug: p.slug }));
  res.render('edit', { title: `Edit: ${page.title} — OnlineWiki`, page, isNew: false, selectPages, presetParent, existingTitles, csrfToken: res.locals.csrfToken });
});

app.post('/pages/:slug/edit', ensureRole('editor'), (req, res) => {
  const slug = req.params.slug;
  const page = loadPage(slug);
  if (!page) return res.status(404).send('Page not found');

  const confirmDuplicate = (req.body.confirmDuplicate || '').toString().toLowerCase() === 'true';
  const newTitle = (req.body.title || page.title || '').trim();

  // Title-duplicate guard — case-insensitive match against OTHER pages only
  // (the current page itself is allowed to keep its own title unchanged).
  if (newTitle) {
    const dupTitleMatch = listPages().find(p =>
      p.slug !== slug &&
      p.title &&
      p.title.toLowerCase() === newTitle.toLowerCase());
    if (dupTitleMatch && !confirmDuplicate) {
      req.flash('error',
        `Another page titled "${dupTitleMatch.title}" already exists (slug: ${dupTitleMatch.slug}). ` +
        `Confirm the save again if you want to proceed with a duplicate title.`);
      return res.redirect(`/pages/${slug}/edit`);
    }
  }

  // ── Optimistic concurrency check ─────────────────────────────────────────
  const { editedAt } = req.body;
  if (editedAt && page.updatedAt && editedAt !== page.updatedAt) {
    const who = page.lastEditorDisplay || page.lastEditor || 'someone else';
    req.flash('error',
      `⚠ This page was modified by ${who} while you were editing. ` +
      `Your changes have been saved, but please review the content for any conflicts.`
    );
  }

  // ── Parent cycle / existence validation (mirrors GET handler's UI filter) ─
  const newParent = (req.body.parent || '').trim() || null;
  if (newParent) {
    if (newParent === slug) {
      req.flash('error', 'A page cannot be its own parent.');
      return res.redirect(`/pages/${slug}/edit`);
    }
    const descendants = getDescendants(slug, listPages());
    if (descendants.has(newParent)) {
      req.flash('error', `Cannot set parent to "${newParent}" — that would create a cycle.`);
      return res.redirect(`/pages/${slug}/edit`);
    }
    if (!loadPage(newParent)) {
      req.flash('error', `Parent page "${newParent}" does not exist.`);
      return res.redirect(`/pages/${slug}/edit`);
    }
  }

  page.title             = (req.body.title || page.title).trim();
  page.content           = sanitizeContent(req.body.content || '');
  page.tags              = (req.body.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  page.parent            = newParent;
  page.position          = isNaN(parseInt(req.body.position)) ? (page.position ?? 0) : parseInt(req.body.position);
  page.updatedAt         = new Date().toISOString();
  page.lastEditor        = req.user.username;
  page.lastEditorDisplay = req.user.displayName;
  savePage(page);

  auditLogger.info('PAGE_EDITED', { slug: req.params.slug, title: page.title, editor: req.user.username, ip: req.ip });
  req.flash('success', 'Page saved successfully.');
  res.redirect(`/pages/${req.params.slug}`);
});

app.post('/pages/:slug/delete', ensureRole('editor'), (req, res) => {
  const page = loadPage(req.params.slug);
  const file = path.join(PAGES_DIR, `${req.params.slug}.json`);
  if (fs.existsSync(file)) {
    // Re-parent orphaned children up to this page's parent (keeps hierarchy intact)
    if (page) {
      listPages()
        .filter(p => p.parent === req.params.slug)
        .forEach(child => { child.parent = page.parent || null; savePage(child); });
    }
    fs.removeSync(file);
  }
  auditLogger.info('PAGE_DELETED', { slug: req.params.slug, deletedBy: req.user.username, ip: req.ip });
  req.flash('success', 'Page deleted.');
  const returnTo = page && page.parent ? `/pages/${page.parent}` : '/';
  res.redirect(returnTo);
});

// ─── Sibling reorder (move up / down within same parent) ──────────────────────
app.post('/pages/:slug/move', ensureRole('editor'), (req, res) => {
  const { direction } = req.body;  // 'up' or 'down'
  const page = loadPage(req.params.slug);
  if (!page) return res.status(404).send('Not found');

  const pages      = listPages();
  const parentSlug = page.parent || null;

  // Normalise positions so they are 0…n-1 integers, then sort
  let siblings = pages
    .filter(p => (p.parent || null) === parentSlug)
    .sort((a, b) => ((a.position ?? 9999) - (b.position ?? 9999)) || a.title.localeCompare(b.title))
    .map((s, i) => ({ ...s, position: i }));

  const idx     = siblings.findIndex(s => s.slug === page.slug);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;

  if (idx >= 0 && swapIdx >= 0 && swapIdx < siblings.length) {
    // Swap position values
    [siblings[idx].position, siblings[swapIdx].position] =
      [siblings[swapIdx].position, siblings[idx].position];
    savePage(siblings[idx]);
    savePage(siblings[swapIdx]);
    req.flash('success', `Page moved ${direction}.`);
  }

  // Same-origin redirect override — keep editors on the page they were viewing
  // (parent, home, section anchor) instead of always jumping to the moved page.
  const safeRedirect =
    (typeof req.body.redirect === 'string' &&
     req.body.redirect.startsWith('/') &&
     !req.body.redirect.startsWith('//'))
    ? req.body.redirect
    : null;
  res.redirect(safeRedirect || `/pages/${req.params.slug}`);
});

// ─── Attachment management (JSON API) ─────────────────────────────────────────
app.post('/pages/:slug/attach', ensureRole('editor'), (req, res) => {
  const page = loadPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!page.attachments) page.attachments = [];
  if (!page.attachments.includes(filename)) {
    page.attachments.push(filename);
    savePage(page);
  }
  res.json({ ok: true, attachments: page.attachments });
});

app.post('/pages/:slug/detach', ensureRole('editor'), (req, res) => {
  const page = loadPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const { filename } = req.body;
  page.attachments = (page.attachments || []).filter(f => f !== filename);
  savePage(page);
  res.json({ ok: true, attachments: page.attachments });
});

// TinyMCE pasted-image / inserted-image upload endpoint.
// Called by editor.js images_upload_handler as a JSON POST with base64 payload.
// Stores the decoded bytes into UPLOADS_DIR (same folder as all uploads so the
// static route serves them) and returns { location: '/uploads/:stored_name' }.
// Works for both existing pages (:slug = real slug) AND unsaved new pages where
// the client sends slug = '_new_page_placeholder_' — we still accept the upload
// so users can paste images before saving the page for the first time.
const IMAGE_MIME_TO_EXT = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/bmp':  '.bmp'
};
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB pasted-image cap (separate from 50MB doc uploads)

app.post('/pages/:slug/image-upload', ensureRole('editor'), express.json({ limit: IMAGE_MAX_BYTES * 2 }), (req, res) => {
  try {
    const { filename, mime, data } = req.body || {};
    if (!mime || !IMAGE_MIME_TO_EXT[mime]) {
      return res.status(400).json({ error: 'Unsupported image type. Allowed: PNG, JPG, GIF, SVG, WEBP, BMP.' });
    }
    if (typeof data !== 'string' || data.length === 0) {
      return res.status(400).json({ error: 'No image data provided.' });
    }
    if (data.length > IMAGE_MAX_BYTES * 1.5) {
      // base64 size ≈ 1.33x binary size; be permissive but protect against 100MB blobs
      return res.status(413).json({ error: 'Image too large. Maximum pasted image size is 10 MB.' });
    }
    let bytes;
    try {
      bytes = Buffer.from(data, 'base64');
    } catch {
      return res.status(400).json({ error: 'Image base64 data is invalid.' });
    }
    if (bytes.length > IMAGE_MAX_BYTES) {
      return res.status(413).json({ error: 'Image too large. Maximum pasted image size is 10 MB.' });
    }
    const ext = IMAGE_MIME_TO_EXT[mime];
    // Reuse the same sanitize-and-prefix naming strategy as multer uploads.
    const base = typeof filename === 'string' ? filename : ('pasted-' + Date.now() + ext);
    const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Sanity: ensure extension matches declared MIME to avoid extension spoofing
    const existingExt = path.extname(safeBase).toLowerCase();
    const finalBase = existingExt === ext ? safeBase : (safeBase.replace(/\.[^.]*$/, '') + ext);
    const storedName = `${Date.now()}_${finalBase}`;
    const fullPath = path.join(UPLOADS_DIR, storedName);
    // Containment check (belt and braces — should be impossible given sanitization)
    assertWithinBaseDir(fullPath, UPLOADS_DIR);
    fs.writeFileSync(fullPath, bytes);
    auditLogger.info('IMAGE_PASTED_UPLOADED', {
      storedAs: storedName,
      originalName: base,
      sizeBytes: bytes.length,
      mime,
      uploadedBy: req.user?.username,
      pageSlug: req.params.slug,
      ip: req.ip
    });
    // Return absolute-path URL to image so TinyMCE can embed it immediately.
    // express.static(UPLOADS_DIR mounted at '/uploads' serves this file.
    res.json({ location: '/uploads/' + encodeURIComponent(storedName) });
  } catch (err) {
    systemLogger.error('image-upload failed', { error: err.message, user: req.user?.username, ip: req.ip });
    res.status(500).json({ error: err.message || 'Image upload failed.' });
  }
});

// ─── Uploads ───────────────────────────────────────────────────────────────────
app.get('/uploads', ensureAuth, (req, res) => {
  // Never allow the browser or any proxy to cache this page.  Each render
  // embeds a fresh session-bound CSRF token into the upload/delete forms;
  // stale cached pages lead to "invalid csrf token" rejections on submit.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.render('uploads', { title: 'Documents — OnlineWiki', files: listUploads(), csrfToken: res.locals.csrfToken });
});

// Upload helper — wraps multer in a promise so async/await works cleanly
function runMulterUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, err => {
      if (err) reject(err); else resolve();
    });
  });
}

app.post('/uploads', ensureRole('editor'), async (req, res, next) => {
  // Hard response deadline.  Multer can theoretically hang waiting for a stream
  // event that never fires (large uploads, mid-upload client aborts, etc.).
  // If the handler hasn't written a response within UPLOAD_TIMEOUT_MS, send a
  // user-friendly 408/500 and END the response — this prevents the morgan
  // "- -" dash-columns / Chrome ERR_FAILED symptom entirely.
  const UPLOAD_TIMEOUT_MS = 45 * 1000;  // 45 seconds — enough for 50MB on slow I/O
  let responded = false;
  const safeEnd = () => { if (responded) return; responded = true; };
  const deadlineTimer = setTimeout(() => {
    if (responded) return;
    responded = true;
    systemLogger.error('Upload handler timed out — sending deadline response', {
      user: req.user?.username, ip: req.ip
    });
    try { req.flash('error', 'Upload timed out. Please try again with a smaller file, or check your network.'); } catch {}
    try {
      req.session.save(() => {
        try { res.status(408); if (!res.headersSent) res.redirect('/uploads'); else res.end(); }
        catch { try { res.status(500).type('text/plain').send('Upload timed out.'); } catch {} }
      });
    } catch {
      try { res.status(500).type('text/plain').send('Upload timed out.'); } catch {}
    }
  }, UPLOAD_TIMEOUT_MS);
  const _origEnd = res.end.bind(res);
  res.end = function patchedEnd(...a) { clearTimeout(deadlineTimer); safeEnd(); return _origEnd(...a); };
  const _origRedirect = res.redirect.bind(res);
  res.redirect = function patchedRedirect(...a) { clearTimeout(deadlineTimer); safeEnd(); return _origRedirect(...a); };
  const _origRender = res.render.bind(res);
  res.render = function patchedRender(...a) { clearTimeout(deadlineTimer); safeEnd(); return _origRender(...a); };
  const _origSendStatus = res.sendStatus.bind(res);
  res.sendStatus = function patchedSendStatus(...a) { clearTimeout(deadlineTimer); safeEnd(); return _origSendStatus(...a); };
  try {
    // 1. Parse the multipart form (file + hidden fields like _csrf)
    await runMulterUpload(req, res);
    if (responded) return;
    // 2. Route-local CSRF check — _csrf is now in req.body because multer
    //    extracted all form fields from the multipart stream.  We do a
    //    constant-time manual compare instead of invoking the inner middleware
    //    (which can hang waiting for body stream events that already fired).
    const csrfPassed = verifyCsrfConstantTime(req);
    if (!csrfPassed) {
      systemLogger.warn('CSRF token validation failed on upload', {
        ip: req.ip, user: req.user?.username
      });
      req.flash('error', 'Upload rejected: invalid or missing CSRF token. Please refresh the page and try again.');
      return req.session.save(() => { clearTimeout(deadlineTimer); safeEnd(); res.redirect('/uploads'); });
    }
    if (!req.file) {
      systemLogger.warn('Upload attempt with no file', { user: req.user?.username, ip: req.ip });
      req.flash('error', 'Please select a file to upload.');
    } else {
      auditLogger.info('FILE_UPLOADED', { filename: req.file.originalname, storedAs: req.file.filename, sizeBytes: req.file.size, uploadedBy: req.user.username, ip: req.ip });
      req.flash('success', `"${req.file.originalname}" uploaded successfully.`);
    }
    // Explicitly save session before redirect to prevent Windows race-condition
    // that drops the flash message and causes ERR_FAILED
    req.session.save(saveErr => {
      if (saveErr) systemLogger.warn('Session save failed after upload', { error: saveErr.message });
      clearTimeout(deadlineTimer); safeEnd();
      res.redirect('/uploads');
    });
  } catch (err) {
    systemLogger.error('Upload failed', { error: err.message, user: req.user?.username, ip: req.ip });
    req.flash('error', err.message || 'Upload failed. Please try again.');
    req.session.save(() => { clearTimeout(deadlineTimer); safeEnd(); res.redirect('/uploads'); });
  }
});

app.get('/uploads/download/:filename', ensureAuth, (req, res) => {
  const safePath = assertWithinBaseDir(req.params.filename, UPLOADS_DIR);
  if (!safePath || !fs.existsSync(safePath)) {
    return res.status(404).render('error', {
      title: '404', statusCode: 404,
      user:     res.locals.user     || null,
      flash:    res.locals.flash    || { error: [], success: [], info: [] },
      navFlat:  res.locals.navFlat  || [],
      navPages: res.locals.navPages || [],
      csrfToken: res.locals.csrfToken || '',
      message: 'File not found.'
    });
  }
  const friendlyName = req.params.filename.replace(/^\d+_/, '');
  res.download(safePath, friendlyName);
});

app.post('/uploads/delete/:filename', ensureRole('editor'), (req, res) => {
  const safePath = assertWithinBaseDir(req.params.filename, UPLOADS_DIR);
  if (safePath && fs.existsSync(safePath)) {
    fs.removeSync(safePath);
    // Cascade-remove from all page attachment lists
    listPages().forEach(p => {
      if ((p.attachments || []).includes(req.params.filename)) {
        p.attachments = p.attachments.filter(f => f !== req.params.filename);
        savePage(p);
      }
    });
  }
  auditLogger.info('FILE_DELETED', { filename: req.params.filename, deletedBy: req.user.username, ip: req.ip });
  req.flash('success', 'File deleted.');
  // Explicit session save before redirect — on Windows session-file-store
  // can race and drop the flash if we redirect before the write completes.
  req.session.save(saveErr => {
    if (saveErr) systemLogger.warn('Session save failed after delete', { error: saveErr.message });
    res.redirect('/uploads');
  });
});

// ─── Static serve of uploaded files (images/pdf etc.) ─────────────────────────
// Mount AFTER all specific /uploads/* routes (/download, /delete, GET/POST /uploads)
// so those always take precedence. Require auth + belt+braces path containment.
app.use('/uploads', ensureAuth, function (req, res, next) {
  const safe = assertWithinBaseDir(req.path.replace(/^\//, ''), UPLOADS_DIR);
  if (!safe) return res.status(400).type('text/plain').send('Bad request path.');
  next();
}, express.static(UPLOADS_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  immutable: process.env.NODE_ENV === 'production',
  etag: true,
  fallthrough: true
}));

// ─── Admin: user management ───────────────────────────────────────────────────
app.get('/admin/users', ensureRole('administrator'), (req, res) => {
  const registry = loadUsers();
  const users    = Object.values(registry)
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(u => Object.assign({}, u, { avatarUrl: avatarUrlFor(u.avatar) }));
  res.render('admin/users', {
    title: 'User Management — OnlineWiki',
    users,
    localAdminUsername: process.env.LOCAL_ADMIN_USERNAME || '',
    csrfToken: res.locals.csrfToken
  });
});

app.post('/admin/users/:username/role', ensureRole('administrator'), (req, res) => {
  const { username } = req.params;
  const { role }     = req.body;
  const VALID_ROLES  = ['reader', 'editor', 'administrator'];
  const envAdmin     = (process.env.LOCAL_ADMIN_USERNAME || '').toLowerCase();

  if (!VALID_ROLES.includes(role)) {
    req.flash('error', 'Invalid role.');
    return res.redirect('/admin/users');
  }
  // Prevent self-demotion
  if (username === req.user.username) {
    req.flash('error', 'You cannot change your own role.');
    return res.redirect('/admin/users');
  }
  // The env-based local admin is always administrator — cannot be changed here
  if (username.toLowerCase() === envAdmin) {
    req.flash('error', 'The environment local admin is always an administrator — role cannot be changed here.');
    return res.redirect('/admin/users');
  }

  const registry = loadUsers();
  if (!registry[username]) {
    req.flash('error', `User "${username}" not found in registry.`);
    return res.redirect('/admin/users');
  }
  const prevRole = registry[username].role;
  registry[username].role = role;
  saveUsers(registry);
  auditLogger.info('ROLE_CHANGED', { targetUsername: username, displayName: registry[username].displayName, previousRole: prevRole, newRole: role, changedBy: req.user.username, ip: req.ip });
  req.flash('success', `Role for ${registry[username].displayName || username} updated to ${role}.`);
  res.redirect('/admin/users');
});

// ─── Create local account ────────────────────────────────────────────────────
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,59}$/i;
const VALID_ROLES = ['reader', 'editor', 'administrator'];

function _sanitizePlain(s, max) {
  const v = typeof s === 'string' ? s : '';
  return sanitizeHtml(v, { allowedTags: [], allowedAttributes: {}, allowedSchemes: [], disallowedTagsMode: 'escape', parser: { decodeEntities: true } })
    .replace(/<[^>]+>/g, '').trim().substring(0, Math.max(0, max | 0));
}

app.post('/admin/users/new', ensureRole('administrator'), (req, res) => {
  const rawUsername = (req.body.username || '').trim();
  const displayName = _sanitizePlain(req.body.displayName, 80);
  const email       = _sanitizePlain(req.body.email, 254);
  const password    = typeof req.body.password === 'string' ? req.body.password : '';
  const confirmPwd  = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
  const role        = typeof req.body.role === 'string' && VALID_ROLES.includes(req.body.role) ? req.body.role : 'reader';

  const username    = rawUsername.toLowerCase();
  const envAdmin    = (process.env.LOCAL_ADMIN_USERNAME || '').toLowerCase();

  if (!USERNAME_RE.test(username)) {
    req.flash('error', 'Invalid username. Use 2–60 letters, numbers, and . _ - only.');
    return res.redirect('/admin/users');
  }
  if (username === envAdmin) {
    req.flash('error', 'This username is reserved for the environment-based local administrator.');
    return res.redirect('/admin/users');
  }
  if (!displayName) {
    req.flash('error', 'Display name is required.');
    return res.redirect('/admin/users');
  }
  if (password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return res.redirect('/admin/users');
  }
  if (password !== confirmPwd) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/admin/users');
  }

  const now = new Date().toISOString();
  const apply = () => {
    const registry = loadUsers();
    if (registry[username]) {
      req.flash('error', `Username "${username}" already exists.`);
      return res.redirect('/admin/users');
    }
    const record = {
      username,
      displayName,
      email,
      role,
      source: 'local',
      passwordHash: hashPassword(password),
      registeredAt: now,
      lastLoginAt: null
    };
    registry[username] = record;
    saveUsers(registry);
    auditLogger.info('USER_CREATED', { targetUsername: username, displayName, role, source: 'local', createdBy: req.user.username, ip: req.ip });
    req.flash('success', `Local account "${displayName}" (${username}) created successfully with role "${role}".`);
    res.redirect('/admin/users');
  };
  if (!_userLock.busy) {
    _userLock.busy = true;
    try { return apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); }
  }
  _userLock.queue.push(() => { try { apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); } });
});

// ─── Reset / set / clear password for any user ────────────────────────────────
app.post('/admin/users/:username/reset-password', ensureRole('administrator'), (req, res) => {
  const { username } = req.params;
  const newPassword  = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  const confirmPwd   = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
  const envAdmin     = (process.env.LOCAL_ADMIN_USERNAME || '').toLowerCase();

  if (username === req.user.username) {
    req.flash('error', 'You cannot reset your own password here.');
    return res.redirect('/admin/users');
  }
  if (username.toLowerCase() === envAdmin) {
    req.flash('error', 'The environment local admin password must be changed via the .env file.');
    return res.redirect('/admin/users');
  }
  if (newPassword && newPassword.length < 8) {
    req.flash('error', 'Password must be at least 8 characters, or leave both fields empty to remove local access.');
    return res.redirect('/admin/users');
  }
  if (newPassword !== confirmPwd) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/admin/users');
  }

  const apply = () => {
    const registry = loadUsers();
    if (!registry[username]) {
      req.flash('error', `User "${username}" not found.`);
      return res.redirect('/admin/users');
    }
    const record = registry[username];
    const hadLocal = !!record.passwordHash;
    if (newPassword) {
      record.passwordHash = hashPassword(newPassword);
      if (!record.source || record.source === 'ldap') record.source = 'hybrid';
      else if (record.source !== 'local' && record.source !== 'hybrid') record.source = 'hybrid';
      auditLogger.info('USER_PASSWORD_SET', { targetUsername: username, displayName: record.displayName, wasLocal: hadLocal, source: record.source, changedBy: req.user.username, ip: req.ip });
      req.flash('success', `Password for ${record.displayName || username} set. Local login enabled.`);
    } else {
      delete record.passwordHash;
      if (record.source === 'local') {
        // Local-only account losing its password — mark as ldap-pending, but since
        // they have no domain login, keep the record; just demote source to show no local access
        record.source = 'ldap';
      } else if (record.source === 'hybrid') {
        record.source = 'ldap';
      }
      auditLogger.info('USER_PASSWORD_CLEARED', { targetUsername: username, displayName: record.displayName, previousSource: hadLocal ? 'local/hybrid' : record.source, source: record.source, changedBy: req.user.username, ip: req.ip });
      req.flash('success', `Local password for ${record.displayName || username} removed. User must log in via Active Directory.`);
    }
    saveUsers(registry);
    res.redirect('/admin/users');
  };
  if (!_userLock.busy) {
    _userLock.busy = true;
    try { return apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); }
  }
  _userLock.queue.push(() => { try { apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); } });
});

// ─── Delete user ─────────────────────────────────────────────────────────────
app.post('/admin/users/:username/delete', ensureRole('administrator'), (req, res) => {
  const { username } = req.params;
  const envAdmin     = (process.env.LOCAL_ADMIN_USERNAME || '').toLowerCase();
  if (username === req.user.username) {
    req.flash('error', 'You cannot delete your own account.');
    return res.redirect('/admin/users');
  }
  if (username.toLowerCase() === envAdmin) {
    req.flash('error', 'The environment local admin cannot be deleted here.');
    return res.redirect('/admin/users');
  }
  const apply = () => {
    const registry = loadUsers();
    if (!registry[username]) {
      req.flash('error', `User "${username}" not found.`);
      return res.redirect('/admin/users');
    }
    const displayName = registry[username].displayName;
    const source      = registry[username].source || 'ldap';
    delete registry[username];
    saveUsers(registry);
    auditLogger.info('USER_DELETED', { targetUsername: username, displayName, source, deletedBy: req.user.username, ip: req.ip });
    req.flash('success', `User "${displayName || username}" deleted.`);
    res.redirect('/admin/users');
  };
  if (!_userLock.busy) {
    _userLock.busy = true;
    try { return apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); }
  }
  _userLock.queue.push(() => { try { apply(); } finally { _userLock.busy = false; const nxt = _userLock.queue.shift(); if (nxt) setImmediate(nxt); } });
});

// ─── Admin: site settings (custom titles) ─────────────────────────────────────
function _trimTo(str, max) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, Math.max(0, max | 0));
}

app.get('/admin/settings', ensureRole('administrator'), (req, res) => {
  res.render('admin/settings', {
    title:    'Site Settings — OnlineWiki',
    settings: loadSettings(),
    csrfToken: res.locals.csrfToken
  });
});

app.post('/admin/settings', ensureRole('administrator'), (req, res) => {
  const raw = req.body;
  const PLAINTEXT_OPTS = {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: 'escape',
    parser: { decodeEntities: true }
  };
  const stripPlain = s => {
    const v = typeof s === 'string' ? s : '';
    return sanitizeHtml(v, PLAINTEXT_OPTS).replace(/<[^>]+>/g, '');
  };
  const trimmed = {
    siteTitle:    _trimTo(stripPlain(raw.siteTitle),    80),
    siteTagline:  _trimTo(stripPlain(raw.siteTagline),  200),
    homeHeading:  _trimTo(stripPlain(raw.homeHeading),  80),
    homeSubtitle: _trimTo(stripPlain(raw.homeSubtitle), 160)
  };

  if (!trimmed.siteTitle)   trimmed.siteTitle   = DEFAULT_SETTINGS.siteTitle;
  if (!trimmed.homeHeading) trimmed.homeHeading = DEFAULT_SETTINGS.homeHeading;

  const saved = saveSettings(trimmed);

  auditLogger.info('SETTINGS_UPDATED', {
    changedBy: req.user.username, ip: req.ip,
    newTitles: { siteTitle: saved.siteTitle, homeHeading: saved.homeHeading }
  });
  req.flash('success', 'Site settings saved.');
  res.redirect('/admin/settings');
});

// ─── API: upload list for attachment picker ────────────────────────────────────
app.get('/api/uploads', ensureAuth, (req, res) => {
  res.json(listUploads());
});

// ─── Helpers: full-text page search ───────────────────────────────────────────
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Preserve image alt/title text as image descriptions
    .replace(/<img\b([^>]*)>/gi, (match, attrs) => {
      const altM   = attrs.match(/alt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const titleM = attrs.match(/title\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const alt   = altM   ? (altM[2] || altM[3] || altM[4] || '') : '';
      const title = titleM ? (titleM[2] || titleM[3] || titleM[4] || '') : '';
      const parts = [];
      if (alt)   parts.push(' ' + alt + ' ');
      if (title && title !== alt) parts.push(' ' + title + ' ');
      return parts.length ? ' ' + parts.join(' ') + ' ' : ' ';
    })
    // Preserve anchor href filename / link title for downloadable files
    .replace(/<a\b([^>]*)>/gi, (match, attrs) => {
      const titleM = attrs.match(/title\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const title = titleM ? (titleM[2] || titleM[3] || titleM[4] || '') : '';
      return title ? (' ' + title + ' ') : ' ';
    })
    .replace(/<svg\b[^>]*>/gi, ' ')
    .replace(/<figure\b[^>]*>/gi, ' ')
    .replace(/<\/(svg|figure)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSnippet(text, query, radius) {
  const q = String(query || '').toLowerCase().trim();
  const t = String(text || '');
  const r = typeof radius === 'number' ? radius : 90;
  if (!q) return t.length > r * 2 ? t.substring(0, r * 2) + '…' : t;
  const idx = t.toLowerCase().indexOf(q);
  if (idx === -1) return t.length > r * 2 ? t.substring(0, r * 2) + '…' : t;
  const start = Math.max(0, idx - r);
  const end   = Math.min(t.length, idx + q.length + r);
  const lead  = start > 0 ? '…' : '';
  const trail = end   < t.length ? '…' : '';
  return lead + t.substring(start, end) + trail;
}

function escapeHtmlAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlightMatch(text, query) {
  const q = String(query || '').trim();
  const s = String(text == null ? '' : text);
  if (!q) return escapeHtmlAttr(s);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return escapeHtmlAttr(s).replace(re, '<mark class="search-highlight">$1</mark>');
}

// ─── API: full-text page search ───────────────────────────────────────────────
app.get('/api/search', ensureAuth, (req, res) => {
  const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
  const q    = rawQ.toLowerCase().trim();

  if (!q) {
    res.json({ query: rawQ, matches: 0, results: [] });
    return;
  }

  const results = [];
  listPages().forEach(p => {
    const title    = p.title || '';
    const tagsStr  = Array.isArray(p.tags) ? p.tags.join(' ') : '';
    const slug     = p.slug || '';
    const body     = stripHtml(p.content);

    const titleL = title.toLowerCase();
    const tagsL  = tagsStr.toLowerCase();
    const slugL  = slug.toLowerCase();
    const bodyL  = body.toLowerCase();

    let score = 0;
    let hitField = null;
    if (titleL.includes(q)) { score += 100; hitField = 'title'; }
    if (tagsL.includes(q))  { score += 40;  if (!hitField) hitField = 'tags'; }
    if (slugL.includes(q))  { score += 25;  if (!hitField) hitField = 'slug'; }
    if (bodyL.includes(q))  { score += 10;  if (!hitField) hitField = 'body'; }

    if (score === 0) return;

    const snippetSrc =
      hitField === 'body'  ? body     :
      hitField === 'tags'  ? tagsStr  :
      hitField === 'slug'  ? slug     : title;
    const snippet = buildSnippet(snippetSrc || title || body, q, 100);

    results.push({
      slug:           p.slug,
      title:          title,
      titleHtml:      highlightMatch(title, q),
      snippetHtml:    highlightMatch(snippet, q),
      tags:           Array.isArray(p.tags) ? p.tags : [],
      parent:         p.parent || null,
      updatedAt:      p.updatedAt || null,
      authorDisplay:  p.authorDisplay || p.author || null,
      score:          score,
      hitField:       hitField
    });
  });

  results.sort((a, b) => (b.score - a.score) || (a.title.localeCompare(b.title)));

  res.json({
    query: rawQ,
    matches: results.length,
    results: results.slice(0, 100)
  });
});

// ─── Avatars static (auth gated, containment-checked) ─────────────────────────
app.use('/avatars', ensureAuth, function (req, res, next) {
  const candidate = assertWithinBaseDir(decodeURIComponent(req.path.slice(1)), AVATARS_DIR);
  if (!candidate) return res.sendStatus(404);
  fs.stat(candidate, (err, st) => {
    if (err || !st.isFile()) return res.sendStatus(404);
    res.sendFile(candidate, { etag: true, maxAge: '7d' });
  });
});

// ─── Profile (avatar + display + self-service edit) ───────────────────────────
app.get('/profile', ensureAuth, (req, res) => {
  let record = null;
  if (!req.user._localAdmin) {
    try { record = loadUsers()[req.user.username] || null; } catch { /* ignore */ }
  }
  res.render('profile', {
    title: 'My Profile — OnlineWiki',
    record,
    avatarUrl: avatarUrlFor(req.user.avatar),
    csrfToken: res.locals.csrfToken
  });
});

function _plaintextSanitizeAvatar(s) {
  if (typeof s !== 'string') return '';
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} }).trim();
}

function _updateCurrentUserRecord(username, mutate) {
  return new Promise((resolve, reject) => {
    const apply = () => {
      try {
        const registry = loadUsers();
        const now = new Date().toISOString();
        const isEnvAdmin = username === process.env.LOCAL_ADMIN_USERNAME;
        if (!registry[username]) registry[username] = {
          username,
          displayName: username,
          email: '',
          role: isEnvAdmin ? 'administrator' : 'reader',
          source: 'local',
          registeredAt: now,
          lastLoginAt: now
        };
        // Guarantee env-admin can never be demoted even if the record already
        // existed with an incorrect role (e.g. legacy data, earlier partial save).
        if (isEnvAdmin) registry[username].role = 'administrator';
        mutate(registry[username], registry);
        saveUsers(registry);
        resolve(registry[username]);
      } catch (e) { reject(e); }
    };
    if (!_userLock.busy) {
      _userLock.busy = true;
      try { apply(); }
      finally {
        _userLock.busy = false;
        const nx = _userLock.queue.shift();
        if (nx) setImmediate(nx);
      }
    } else {
      _userLock.queue.push(() => {
        try { apply(); }
        finally {
          _userLock.busy = false;
          const nx = _userLock.queue.shift();
          if (nx) setImmediate(nx);
        }
      });
    }
  });
}

function _deleteAvatarFile(filename) {
  if (!filename) return;
  try {
    const candidate = assertWithinBaseDir(filename, AVATARS_DIR);
    if (candidate && fs.existsSync(candidate)) fs.unlinkSync(candidate);
  } catch (e) {
    systemLogger.warn('Failed to clean up old avatar file', { filename, error: e.message });
  }
}

function _saveAvatarFromDataUrl(dataUrl, username, oldFilename) {
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No avatar data provided.');
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!m) throw new Error('Avatar must be a PNG, JPEG, or WebP image.');
  const ext = (m[1] === 'jpeg' || m[1] === 'jpg') ? '.jpg' : `.${m[1].toLowerCase()}`;
  if (!AVATAR_ALLOWED_EXT.includes(ext)) throw new Error('Unsupported avatar image format.');
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { throw new Error('Avatar image data is corrupt.'); }
  if (buf.length === 0) throw new Error('Avatar image is empty.');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Avatar image is too large (max 4 MB).');
  const safeUser = username.replace(/[^a-zA-Z0-9._-]/g, '_') || 'user';
  const filename = `${safeUser}-${Date.now()}${ext}`;
  const abs = path.join(AVATARS_DIR, filename);
  const checked = assertWithinBaseDir(path.basename(filename), AVATARS_DIR);
  if (!checked) throw new Error('Invalid avatar filename.');
  fs.writeFileSync(checked, buf);
  if (oldFilename && oldFilename !== filename) _deleteAvatarFile(oldFilename);
  return filename;
}

app.post('/profile', ensureAuth, async (req, res) => {
  try {
    const username = req.user.username;
    const isEnvAdmin = !!req.user._localAdmin;
    const registry = loadUsers();
    const oldAvatar = (registry[username] || {}).avatar || null;

    // Display name + email are allowed for all users (self-update)
    let displayName = _plaintextSanitizeAvatar(req.body.displayName || '').slice(0, 80);
    let email = _plaintextSanitizeAvatar(req.body.email || '').slice(0, 254);
    const avatarData = typeof req.body.avatarData === 'string' && req.body.avatarData.startsWith('data:') ? req.body.avatarData : '';
    const clearAvatar = req.body.clearAvatar === '1' || req.body.clearAvatar === 'true';

    let newAvatar = oldAvatar;
    if (clearAvatar) {
      newAvatar = null;
      _deleteAvatarFile(oldAvatar);
    } else if (avatarData) {
      newAvatar = _saveAvatarFromDataUrl(avatarData, username, oldAvatar);
    }

    await _updateCurrentUserRecord(username, (rec) => {
      if (displayName) rec.displayName = displayName;
      if (email !== undefined) rec.email = email;
      if (newAvatar !== undefined) rec.avatar = newAvatar;
      if (clearAvatar) delete rec.avatar;
    });

    auditLogger.info('PROFILE_UPDATED', {
      username, displayName: req.user.displayName,
      avatarChanged: !!avatarData || clearAvatar,
      displayNameChanged: displayName && displayName !== (req.user.displayName || ''),
      emailChanged: email !== (req.user.email || ''),
      ip: req.ip
    });

    req.flash('success', 'Your profile has been updated.');
    res.redirect('/profile');
  } catch (e) {
    systemLogger.warn('Profile update failed', { user: req.user.username, error: e.message });
    req.flash('error', e.message || 'Failed to update profile.');
    res.redirect('/profile');
  }
});

app.post('/profile/avatar/delete', ensureAuth, async (req, res) => {
  try {
    const username = req.user.username;
    const registry = loadUsers();
    const oldAvatar = (registry[username] || {}).avatar || null;
    if (oldAvatar) _deleteAvatarFile(oldAvatar);
    await _updateCurrentUserRecord(username, (rec) => { delete rec.avatar; });
    auditLogger.info('AVATAR_DELETED', { username, displayName: req.user.displayName, ip: req.ip });
    req.flash('success', 'Avatar removed.');
    res.redirect('/profile');
  } catch (e) {
    systemLogger.warn('Avatar delete failed', { user: req.user.username, error: e.message });
    req.flash('error', 'Failed to remove avatar.');
    res.redirect('/profile');
  }
});

// ─── Maintenance endpoints (SYNCTHING session reaper, etc.) ─────────────────
function _maintenanceBearerValid(req) {
  const expected = process.env.MAINTENANCE_TOKEN || '';
  if (!expected) return false;
  const auth = req.headers['authorization'] || '';
  const bea = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bea) return false;
  try {
    const a = Buffer.from(String(bea));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function _ensureMaintenanceAuthorized(req, res, next) {
  const byBearer = _maintenanceBearerValid(req);
  const byAdmin  = req.isAuthenticated() && verifyCsrfConstantTime(req) &&
                   (ROLE_RANK[req.user?.role] ?? 0) >= ROLE_RANK.administrator;
  if (!byBearer && !byAdmin) {
    if (req.isAuthenticated()) res.status(403).json({ ok: false, error: 'Administrator role required.' });
    else                       res.status(401).json({ ok: false, error: 'Authorization: Bearer <MAINTENANCE_TOKEN> required.' });
    return;
  }
  next();
}

app.post('/api/maintenance/expire-sessions', express.json({ limit: '64kb' }), _ensureMaintenanceAuthorized, async (req, res) => {
  const result = await _expireSessionsNow();
  const meta = {
    mode: SESSION_MODE,
    reapable: activeSessionIsReapable,
    calledBy:
      req.isAuthenticated()
        ? { type: 'admin', username: req.user?.username || 'unknown' }
        : { type: 'bearer-token' },
    ip: req.ip,
    at: new Date().toISOString()
  };
  if (result.ok) auditLogger.info('SESSIONS_REAPED', Object.assign({}, meta, { reason: result.reason }));
  else           systemLogger.info('[maintenance] expire-sessions no-op', Object.assign({}, meta, { reason: result.reason }));
  res.json({ ok: result.ok, reason: result.reason, mode: meta.mode, reapable: meta.reapable });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 Not Found', statusCode: 404,
    user:     res.locals.user     || null,
    flash:    res.locals.flash    || { error: [], success: [], info: [] },
    navFlat:  res.locals.navFlat  || [],
    navPages: res.locals.navPages || [],
    csrfToken: res.locals.csrfToken || '',
    message: 'The page you are looking for does not exist.'
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  systemLogger.error('Unhandled request error', {
    error: err.message, stack: err.stack,
    method: req.method, path: req.path,
    user: req.user?.username
  });
  try {
    res.status(500).render('error', {
      title: 'Server Error', statusCode: 500,
      user:     res.locals.user     || null,
      flash:    res.locals.flash    || { error: [], success: [], info: [] },
      navFlat:  res.locals.navFlat  || [],
      navPages: res.locals.navPages || [],
      csrfToken: res.locals.csrfToken || '',
      message: process.env.NODE_ENV === 'development' ? err.message : 'An internal server error occurred.'
    });
  } catch (renderErr) {
    systemLogger.error('Global error-handler 500 render failed — plain-text fallback', {
      renderError: renderErr?.message || String(renderErr)
    });
    res.status(500).type('text/plain').send(
      process.env.NODE_ENV === 'development'
        ? `500 Internal Server Error\r\n${err.message}\r\n\r\n${err.stack || ''}`
        : '500 Internal Server Error'
    );
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  systemLogger.info(`OnlineWiki started`, {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    dataDir: DATA_DIR_ABS,
    logDir:  LOGS_DIR_ABS,
  });
  console.log(`\n📚 OnlineWiki running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Persistent data (DATA_DIR=${DATA_DIR}): ${DATA_DIR_ABS}`);
  console.log(`   Local logs        (LOG_DIR =${LOGS_DIR}):  ${LOGS_DIR_ABS}\n`);
});
