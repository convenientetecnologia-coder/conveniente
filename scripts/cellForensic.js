'use strict';

const fs = require('fs');
const path = require('path');

const EVENTS_PATH = path.join(__dirname, '..', 'dados', 'cells', 'events.jsonl');
const PREV_PATH = path.join(__dirname, '..', 'dados', 'cells', 'events.prev.jsonl');
const LAST_PATH = path.join(__dirname, '..', 'dados', 'cells', 'last.json');
const ARCH_DIR = path.join(__dirname, '..', 'dados', 'logs');
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_ARCH = 24;

function ensureDir() {
  try { fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true }); } catch {}
}

function archiveStamp() {
  const ts = new Date();
  return (
    String(ts.getFullYear()) +
    String(ts.getMonth() + 1).padStart(2, '0') +
    String(ts.getDate()).padStart(2, '0') + '-' +
    String(ts.getHours()).padStart(2, '0') +
    String(ts.getMinutes()).padStart(2, '0') +
    String(ts.getSeconds()).padStart(2, '0')
  );
}

function pruneArchives() {
  try {
    if (!fs.existsSync(ARCH_DIR)) return;
    const re = /^cell_events\.\d{8}-\d{6}\.jsonl$/;
    const hits = fs.readdirSync(ARCH_DIR)
      .filter((n) => re.test(String(n || '')))
      .map((name) => {
        const full = path.join(ARCH_DIR, name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(full).mtimeMs || 0) || 0; } catch {}
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const row of hits.slice(KEEP_ARCH)) {
      try { fs.unlinkSync(row.full); } catch {}
    }
  } catch {}
}

function rotateIfHuge() {
  try {
    const st = fs.existsSync(EVENTS_PATH) ? fs.statSync(EVENTS_PATH) : null;
    if (!st || st.size <= MAX_BYTES) return;
    try { fs.mkdirSync(ARCH_DIR, { recursive: true }); } catch {}
    if (fs.existsSync(PREV_PATH)) {
      const dest = path.join(ARCH_DIR, 'cell_events.' + archiveStamp() + '.jsonl');
      try { fs.renameSync(PREV_PATH, dest); } catch {
        try { fs.copyFileSync(PREV_PATH, dest); } catch {}
        try { fs.unlinkSync(PREV_PATH); } catch {}
      }
      pruneArchives();
    }
    try { fs.renameSync(EVENTS_PATH, PREV_PATH); } catch {}
  } catch {}
}

function append(event, data) {
  const row = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    event: String(event || '').slice(0, 80),
    pid: process.pid,
    ...(data && typeof data === 'object' ? data : {})
  };
  try {
    ensureDir();
    rotateIfHuge();
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(row) + '\n', 'utf8');
    fs.writeFileSync(LAST_PATH, JSON.stringify(row, null, 2), 'utf8');
  } catch {}
  try {
    require('./indexLifecycle.js').append('cell_' + String(event || 'event').slice(0, 60), data || {});
  } catch {}
  return row;
}

module.exports = { append, EVENTS_PATH, LAST_PATH };
