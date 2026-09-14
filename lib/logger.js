'use strict';
/**
 * lib/logger.js
 * 
 * Two separate loggers:
 *   systemLogger  — info/warn/error/debug operational logs  → logs/system-YYYY-MM-DD.log
 *   auditLogger   — user action audit trail                 → logs/audit-YYYY-MM-DD.log
 *
 * Log files rotate daily and are excluded from SyncThing sync (.stignore).
 * Set LOG_LEVEL=debug in .env for verbose output.
 */

const path    = require('path');
const fs      = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Relative to process.cwd() (project root) — resolved by fs / winston at runtime.
// Override per-server with the LOG_DIR env var (can be absolute or relative).
// Logs are per-instance diagnostics and MUST NOT be synced by SyncThing.
const LOG_DIR = (process.env.LOG_DIR || 'logs').trim() || 'logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Formatters ───────────────────────────────────────────────────────────────

/** File format: [2026-09-02 14:00:00.000] INFO: message  {"key":"val"} */
const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '';
    const body    = stack ? `${message}\n${stack}` : message;
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${body}${metaStr}`;
  })
);

/** Console format: coloured, no metadata clutter in development */
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '';
    const body    = stack ? `${message}\n${stack}` : message;
    return `${timestamp} ${level}: ${body}${metaStr}`;
  })
);

// ─── Daily rotate transport factory ───────────────────────────────────────────
function makeRotatingTransport(filenamePrefix, maxFiles) {
  return new winston.transports.DailyRotateFile({
    filename:    path.join(LOG_DIR, `${filenamePrefix}-%DATE%.log`),
    datePattern: 'YYYY-MM-DD',
    maxFiles,
    zippedArchive: false,
    auditFile:     path.join(LOG_DIR, `.${filenamePrefix}-audit.json`),
  });
}

// ─── System logger ────────────────────────────────────────────────────────────
// Winston levels: lower number = higher priority (error:0, warn:1, info:2, http:3, verbose:4, debug:5, silly:6)
// User LOG_LEVEL defaults to 'info'. To ensure HTTP access logs (http level 3)
// are always captured unless the user explicitly narrows to warn/error, we
// coerce 'info' (and anything looser) to 'http'.
const _rawLogLevel = process.env.LOG_LEVEL || 'info';
const _narrowLevels = ['error', 'warn'];
const _effectiveFileLevel = _narrowLevels.includes(_rawLogLevel) ? _rawLogLevel : 'http';

const systemLogger = winston.createLogger({
  levels: { ...winston.config.npm.levels, http: 3 },
  level:      _effectiveFileLevel,
  format:     fileFormat,
  transports: [
    makeRotatingTransport('system', '14d'),
  ],
  exceptionHandlers: [makeRotatingTransport('system-exceptions', '30d')],
  rejectionHandlers: [makeRotatingTransport('system-rejections', '30d')],
});

if (process.env.NODE_ENV !== 'production') {
  const _rawConsole = process.env.LOG_LEVEL || 'http';
  const _consoleLevel = _narrowLevels.includes(_rawConsole) ? _rawConsole : 'http';
  systemLogger.add(new winston.transports.Console({
    level:  _consoleLevel,
    format: consoleFormat,
    handleExceptions: true,
  }));
}

// ─── Audit logger ─────────────────────────────────────────────────────────────
// Structured records of user actions. Always info level, no console output.
const auditLogger = winston.createLogger({
  level:      'info',
  format:     fileFormat,
  transports: [makeRotatingTransport('audit', '90d')],   // keep 90 days
});

module.exports = { systemLogger, auditLogger };
