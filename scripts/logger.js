// scripts/logger.js
// logger.critical(msg, ctx) é para uso exclusivo em logs de corrida de locks/pendings/recovery
// logger.audit(msg, ctx) é para eventos de auditoria que não são warning, nem info, nem debug
'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

const COLOR = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[35m',
  critical: '\x1b[41m',
  audit: '\x1b[32m',
  ts: '\x1b[90m'
};

const LOG_TO_FILE = !!process.env.LOG_TO_FILE; // Para logar também num arquivo (append)
const LOG_FILE = path.join(__dirname, '..', 'dados', 'logger.log');
const DEBUG_MODE = process.env.DEBUG || process.env.LOG_DEBUG || '1';

function shouldLog(level) {
  // Exibe DEBUG somente se ativado
  if (level === LEVELS.DEBUG && (!DEBUG_MODE || DEBUG_MODE === '0')) return false;
  return true;
}

function formatTs(ts) {
  const date = typeof ts === 'number' ? new Date(ts) : new Date();
  return date.toISOString().replace('T', ' ').split('.')[0];
}

function log({ level = LEVELS.INFO, msg = '', ctx = {}, errorObj = null }) {
  if (!shouldLog(level)) return;
  const ts = formatTs();
  let base = msg;
  if (ctx && typeof ctx === 'object' && Object.keys(ctx).length) {
    const ctxList = Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(' ');
    base += ' ' + ctxList;
  }
  if (errorObj && errorObj.stack) base += `\n${errorObj.stack}`;

  const color = COLOR[level] || '';
  const line = `${COLOR.ts}[${ts}]${COLOR.reset} ${color}[${level.toUpperCase()}]${COLOR.reset} ${base}`;
  // Terminal
  if (level === 'critical') {
    console.error(line);
  } else if (level === LEVELS.ERROR) {
    console.error(line);
  } else if (level === LEVELS.WARN) {
    console.warn(line);
  } else if (level === 'audit') {
    console.log(line);
  } else {
    console.log(line);
  }
  // Arquivo (opcional)
  if (LOG_TO_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `[${ts}] [${level.toUpperCase()}] ${base}\n`, { encoding: 'utf8' });
    } catch {}
  }
}

module.exports = {
  info: (msg, ctx) => log({ level: LEVELS.INFO, msg, ctx }),
  warn: (msg, ctx) => log({ level: LEVELS.WARN, msg, ctx }),
  error: (msg, ctx, errorObj) => log({ level: LEVELS.ERROR, msg, ctx, errorObj }),
  debug: (msg, ctx) => log({ level: LEVELS.DEBUG, msg, ctx }),
  critical: (msg, ctx) => log({ level: 'critical', msg, ctx }),
  audit: (msg, ctx) => log({ level: 'audit', msg, ctx }),
  LEVELS,
  log // acesso bruto
};