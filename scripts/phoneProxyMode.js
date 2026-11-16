'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Modo do proxy 4G/5G. Sem o arquivo, o Chrome segue o fluxo atual.
// Não lê túnel, gateway, ProxyCheap, ASocks nem Bright Data.
const MODE_PATH = path.join(__dirname, '..', 'dados', 'phone_proxy_mode.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');
const DEFAULT_WS = 'wss://api.convenientetecnologia.com/ws/phone-proxy';

const holds = new Map();

function readConfig() {
  try {
    if (!fs.existsSync(MODE_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(MODE_PATH, 'utf8'));
    if (!j || j.enabled !== true) return null;
    const secret = String(j.secret || '').trim();
    const wsUrl = String(j.wsUrl || DEFAULT_WS).trim() || DEFAULT_WS;
    const phones = (Array.isArray(j.phones) ? j.phones : []).map((p) => ({
      id: String(p && p.id || '').trim(),
      port: Number(p && p.port || 0) || 0,
      username: String(p && p.username || p && p.id || '').trim(),
      password: String(p && p.password || '')
    })).filter((p) => p.port > 0 && p.port <= 65535 && p.username && p.password);
    if (!secret || !phones.length) return null;
    return { enabled: true, secret, wsUrl, phones };
  } catch {
    return null;
  }
}

function isEnabled() {
  return !!readConfig();
}

function blockReason() {
  try {
    if (!isEnabled()) return '';
    const edge = require('./phoneProxyEdge');
    if (!edge.isUp()) return 'phone_pipe_down';
    return '';
  } catch {
    return 'phone_pipe_down';
  }
}

function hostId() {
  try {
    return String(fs.readFileSync(HOSTID_PATH, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function httpBase(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.origin;
}

function postJson(url, secret, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        'x-phone-proxy-secret': secret
      },
      timeout: 8000
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(data);
    req.end();
  });
}

function localPhone(cfg, port) {
  return (cfg.phones || []).find((p) => p.port === Number(port)) || null;
}

async function takeForLaunch(nome, purpose) {
  const cfg = readConfig();
  if (!cfg) return null;
  const who = String(nome || '').trim();
  if (!who) {
    const err = new Error('phone_proxy_required:missing_profile');
    throw err;
  }
  if (blockReason()) {
    throw new Error('phone_proxy_required:' + blockReason());
  }
  const prev = holds.get(who);
  if (prev && prev.port) {
    prev.refs += 1;
    return {
      proxyServer: `http://127.0.0.1:${prev.port}`,
      port: prev.port,
      username: prev.username,
      password: prev.password
    };
  }
  const secret = cfg.secret;
  const base = httpBase(cfg.wsUrl);
  const leased = await postJson(base + '/api/phone-proxy/lease', secret, {
    hostId: hostId(),
    profile: who,
    purpose: purpose === 'publish' ? 'publish' : 'visit'
  });
  if (!leased || leased.ok !== true || !leased.port) {
    throw new Error('phone_proxy_required:' + String(leased && leased.error || 'no_chair'));
  }
  const phone = localPhone(cfg, leased.port);
  if (!phone) throw new Error('phone_proxy_required:missing_password');
  holds.set(who, {
    port: phone.port,
    username: phone.username,
    password: phone.password,
    refs: 1
  });
  return {
    proxyServer: `http://127.0.0.1:${phone.port}`,
    port: phone.port,
    username: phone.username,
    password: phone.password
  };
}

function heldAuth(nome) {
  const row = holds.get(String(nome || '').trim());
  if (!row || !row.username || !row.password) return null;
  return { username: row.username, password: row.password, port: row.port };
}

async function release(nome) {
  const who = String(nome || '').trim();
  const row = holds.get(who);
  if (!row) return;
  row.refs -= 1;
  if (row.refs > 0) return;
  holds.delete(who);
  const cfg = readConfig();
  if (!cfg) return;
  try {
    await postJson(httpBase(cfg.wsUrl) + '/api/phone-proxy/release', cfg.secret, {
      hostId: hostId(),
      profile: who
    });
  } catch {}
}

module.exports = {
  readConfig,
  isEnabled,
  blockReason,
  takeForLaunch,
  heldAuth,
  release
};
