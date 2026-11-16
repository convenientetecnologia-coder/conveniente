'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'dados', 'proxy_gen_assign.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');
const authByProfile = new Map();

function readAssign() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeAssign(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj));
}

function hostId() {
  try {
    return String(fs.readFileSync(HOSTID_PATH, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

async function listFromPanel() {
  const { readCtConfig, normalizeCtBaseUrl } = require('./ctConfig');
  const cfg = readCtConfig();
  let base = normalizeCtBaseUrl((cfg && cfg.ctBaseUrl) || process.env.CT_BASE_URL || process.env.CT_URL || '');
  if (!base) base = 'https://painel.convenientetecnologia.com';
  const secret = String((cfg && cfg.logIngestSecret) || process.env.LOG_INGEST_SECRET || '').trim();
  const who = hostId();
  if (!secret || !who) return [];
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 8000);
  try {
    const resp = await fetch(String(base).replace(/\/+$/, '') + '/api/proxy-central/assigned', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-log-secret': secret },
      body: JSON.stringify({ hostId: who }),
      signal: ac.signal
    });
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j || j.ok !== true || !Array.isArray(j.proxies)) return [];
    return j.proxies.filter((p) => p && p.id && p.host && p.port);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pickLeast(list, assign, nome) {
  const counts = new Map();
  for (const row of list) counts.set(String(row.id), 0);
  for (const [profile, id] of Object.entries(assign)) {
    if (profile === nome) continue;
    if (!counts.has(String(id))) continue;
    counts.set(String(id), counts.get(String(id)) + 1);
  }
  let best = list[0];
  let bestN = Infinity;
  for (const row of list) {
    const n = counts.get(String(row.id)) || 0;
    if (n < bestN) {
      best = row;
      bestN = n;
    }
  }
  return best;
}

async function takeForLaunch(nome) {
  const who = String(nome || '').trim();
  if (!who) throw new Error('proxy_gen_required:missing_profile');
  const list = await listFromPanel();
  if (!list.length) throw new Error('proxy_gen_required:none');
  const assign = readAssign();
  const byId = new Map(list.map((row) => [String(row.id), row]));
  let row = byId.get(String(assign[who] || ''));
  if (!row) {
    row = pickLeast(list, assign, who);
    assign[who] = String(row.id);
    writeAssign(assign);
  }
  const kind = row.kind === 'socks' ? 'socks' : 'http';
  const scheme = kind === 'socks' ? 'socks5' : 'http';
  const held = {
    id: String(row.id),
    host: String(row.host || ''),
    port: Number(row.port) || 0,
    username: String(row.username || ''),
    password: String(row.password || ''),
    proxyServer: scheme + '://' + String(row.host || '') + ':' + String(Number(row.port) || 0),
    kind
  };
  authByProfile.set(who, held);
  return held;
}

function auth(nome) {
  return authByProfile.get(String(nome || '').trim()) || null;
}

module.exports = { takeForLaunch, auth };
