'use strict';

const fsSync = require('fs');
const path = require('path');
const os = require('os');
const logsFetchCore = require('./logsFetchCore');
const { logsAllowlist } = require('./logsAllowlist.js');
const { resolveEndpoints } = require('./notifierEndpoints');
const { readCtConfig } = require('./ctConfig');

const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');

let hostIdCache = null;

function randId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getOrCreateHostIdSync() {
  try {
    if (hostIdCache) return hostIdCache;
    if (fsSync.existsSync(HOSTID_PATH)) {
      const v = String(fsSync.readFileSync(HOSTID_PATH, 'utf8') || '').trim();
      if (v) {
        hostIdCache = v;
        return v;
      }
    }
  } catch {}
  try {
    fsSync.mkdirSync(path.dirname(HOSTID_PATH), { recursive: true });
    const id = randId();
    fsSync.writeFileSync(HOSTID_PATH, id, 'utf8');
    hostIdCache = id;
    return id;
  } catch {
    return randId();
  }
}

function logsSecret() {
  try {
    const cfg = readCtConfig();
    const fromCfg = String(cfg && cfg.logIngestSecret || '').trim();
    if (fromCfg) return fromCfg;
  } catch {}
  const env = String(process.env.LOG_INGEST_SECRET || '').trim();
  if (env) return env;
  return '';
}

function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || '';
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function tailFileGrep(filePath, { patterns = [], maxBytes = 10_000_000, maxMatches = 600 } = {}) {
  try {
    if (!fsSync.existsSync(filePath)) return { ok: false, error: 'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const readBytes = Math.min(Math.max(0, Number(maxBytes || 0) || 0), size);
    const start = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    const fd = fsSync.openSync(filePath, 'r');
    try { fsSync.readSync(fd, buf, 0, readBytes, start); }
    finally { try { fsSync.closeSync(fd); } catch {} }
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    const pats = Array.isArray(patterns) ? patterns.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!pats.length) return { ok: false, error: 'missing_patterns', filePath };
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      let hit = false;
      for (const p of pats) {
        if (line.includes(p)) { hit = true; break; }
      }
      if (!hit) continue;
      out.push(line);
      if (out.length >= maxMatches) break;
    }
    const truncated = (start > 0) || (out.length >= maxMatches);
    return { ok: true, filePath, bytes: readBytes, lines: out.length, truncated, text: out.join('\n') };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), filePath };
  }
}

async function postLogsIngestOnce(body, timeoutMs) {
  const base = notifierBaseFromEndpoints();
  if (!base) throw new Error('notifier_base_unavailable');
  const sec = logsSecret();
  const AbortCtrl = global.AbortController || require('node-abort-controller');
  const controller = new AbortCtrl();
  const t = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, Math.max(8000, Number(timeoutMs || logsFetchCore.INGEST_TIMEOUT_MS) || logsFetchCore.INGEST_TIMEOUT_MS));
  try {
    const resp = await fetch(`${base}/api/logs/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sec ? { 'X-Log-Secret': sec } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp || !resp.ok) {
      const status = resp ? Number(resp.status || 0) : 0;
      throw new Error(`logs_ingest_http_${status || 'unknown'}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function postLogsToNotifier({ requestId, items }) {
  let hostId = String(hostIdCache || '').trim();
  if (!hostId) {
    try { hostId = String(getOrCreateHostIdSync() || '').trim(); } catch {}
  }
  if (!hostId) throw new Error('hostId_unavailable');
  const packets = logsFetchCore.buildIngestPackets(items);
  const errors = [];
  for (let i = 0; i < packets.length; i += 1) {
    let lastErr = null;
    const body = {
      hostId,
      hostname: (os && os.hostname) ? os.hostname() : '',
      requestId,
      sentAt: Date.now(),
      merge: packets.length > 1,
      packetIndex: i,
      packetTotal: packets.length,
      items: packets[i]
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await postLogsIngestOnce(body, logsFetchCore.INGEST_TIMEOUT_MS);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      errors.push({
        packet: i,
        keys: (packets[i] || []).map((x) => x && x.key).filter(Boolean),
        error: String((lastErr && lastErr.message) || lastErr)
      });
    }
  }
  if (errors.length && errors.length === packets.length) {
    throw new Error('logs_ingest_all_packets_failed:' + String(errors[0] && errors[0].error || 'unknown'));
  }
  return { ok: errors.length === 0, packets: packets.length, errors };
}

async function postFailureIngest(requestId, error) {
  const rid = String(requestId || '').trim();
  if (!rid) return;
  try {
    await postLogsToNotifier({
      requestId: rid,
      items: [{ key: '_porter', ok: false, error: String(error || 'porter_failed') }]
    });
  } catch {}
}

async function execFetchLogs(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const keys = Array.isArray(payload.keys) ? payload.keys.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const tailLines = Math.max(50, Math.min(8000, Number(payload.tailLines || 1200) || 1200));
  const maxBytes = logsFetchCore.clampMaxBytes(payload.maxBytes || 1_200_000);
  const fromStart = payload.fromStart === true || payload.fromEnd === false || String(payload.from || '').toLowerCase() === 'start';
  const byteOffsetRaw = Number(payload.byteOffset);
  const byteOffset = Number.isFinite(byteOffsetRaw) && byteOffsetRaw >= 0 ? Math.floor(byteOffsetRaw) : null;
  if (!requestId) throw new Error('missing_requestId');
  if (!keys.length) throw new Error('missing_keys');
  const allow = logsAllowlist();
  const items = [];
  for (const key of keys.slice(0, logsFetchCore.FETCH_KEYS_MAX)) {
    const fp = allow[key];
    if (!fp) { items.push({ key, ok: false, error: 'not_allowed' }); continue; }
    const r = logsFetchCore.sliceLogFile(fp, { maxLines: tailLines, maxBytes, fromStart, byteOffset });
    items.push({ key, ...r });
  }
  let ingest = null;
  try {
    ingest = await postLogsToNotifier({ requestId, items });
  } catch (e) {
    ingest = { ok: false, error: String((e && e.message) || e) };
  }
  return {
    ok: !!(ingest && ingest.ok !== false),
    requestId,
    keys: items.map((x) => x && x.key).filter(Boolean),
    ingest,
    cursor: items.map((it) => ({
      key: it && it.key,
      ok: !!(it && it.ok),
      fileBytes: it && it.fileBytes,
      nextByte: it && it.nextByte,
      eof: it && it.eof,
      truncated: !!(it && it.truncated)
    }))
  };
}

async function execFetchLogsQuery(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const key = String(payload.key || '').trim();
  const patterns = Array.isArray(payload.patterns) ? payload.patterns : [];
  const maxBytes = Math.max(500_000, Math.min(50_000_000, Number(payload.maxBytes || 10_000_000) || 10_000_000));
  const maxMatches = Math.max(10, Math.min(5000, Number(payload.maxMatches || 600) || 600));
  if (!requestId) throw new Error('missing_requestId');
  if (!key) throw new Error('missing_key');
  const allow = logsAllowlist();
  const fp = allow[key];
  if (!fp) throw new Error('not_allowed');
  const r = tailFileGrep(fp, { patterns, maxBytes, maxMatches });
  const items = [{
    key: `query_${key}`,
    ...r,
    meta: { key, patterns: patterns.map((x) => String(x || '').slice(0, 120)), maxBytes, maxMatches }
  }];
  let ingest = null;
  try {
    ingest = await postLogsToNotifier({ requestId, items });
  } catch (e) {
    ingest = { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: !!(ingest && ingest.ok !== false), requestId, key, ingest, lines: Number(r && r.lines || 0) || 0 };
}

async function execFetchLogsSafe(cmd) {
  try {
    return await execFetchLogs(cmd);
  } catch (e) {
    const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    await postFailureIngest(payload.requestId, (e && e.message) || e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function execFetchLogsQuerySafe(cmd) {
  try {
    return await execFetchLogsQuery(cmd);
  } catch (e) {
    const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    await postFailureIngest(payload.requestId, (e && e.message) || e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  execFetchLogs,
  execFetchLogsQuery,
  execFetchLogsSafe,
  execFetchLogsQuerySafe,
  postFailureIngest,
  tailFileGrep,
  logsSecret,
  notifierBaseFromEndpoints,
  postLogsToNotifier
};
