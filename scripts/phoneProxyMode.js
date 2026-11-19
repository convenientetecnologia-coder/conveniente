'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
// Modo do proxy 4G/5G. Sem o arquivo, o Chrome segue o fluxo atual.
// Não lê túnel, gateway, ProxyCheap, ASocks nem Bright Data.
const MODE_PATH = path.join(__dirname, '..', 'dados', 'phone_proxy_mode.json');
const WAIT_PATH = path.join(__dirname, '..', 'dados', 'phone_proxy_wait.json');
const EDGE_STATE_PATH = path.join(__dirname, '..', 'dados', 'phone_proxy_edge_state.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');
const DEFAULT_WS = 'wss://api.convenientetecnologia.com/ws/phone-proxy';

const holds = new Map();

function load() {
  if (!fs.existsSync(MODE_PATH)) return { error: 'no_file' };
  let j;
  try {
    const raw = String(fs.readFileSync(MODE_PATH, 'utf8') || '').replace(/^\uFEFF/, '');
    j = JSON.parse(raw);
  } catch {
    return { error: 'bad_json' };
  }
  if (!j || j.enabled !== true) return { error: 'disabled' };
  const secret = String(j.secret || '').trim();
  const wsUrl = String(j.wsUrl || DEFAULT_WS).trim() || DEFAULT_WS;
  const phones = (Array.isArray(j.phones) ? j.phones : []).map((p) => ({
    id: String(p && p.id || '').trim(),
    port: Number(p && p.port || 0) || 0,
    username: String(p && p.username || p && p.id || '').trim(),
    password: String(p && p.password || '')
  })).filter((p) => p.port > 0 && p.port <= 65535 && p.username && p.password);
  if (!secret) return { error: 'missing_secret' };
  if (!phones.length) return { error: 'missing_phones' };
  return { cfg: { enabled: true, secret, wsUrl, phones } };
}

function readConfig() {
  return load().cfg || null;
}

function inspect() {
  const x = load();
  const phones = x.cfg ? x.cfg.phones : [];
  return {
    enabled: !!x.cfg,
    reason: x.cfg ? 'ok' : x.error,
    ports: phones.map((p) => p.port)
  };
}

function note(event, extra) {
  try {
    const row = Object.assign({ event: String(event || 'phone_proxy') }, extra || {});
    delete row.password;
    delete row.secret;
    delete row.username;
    require('./provisionAudit').append(row);
  } catch {}
}

function isEnabled() {
  return !!readConfig();
}

function writeEdgeState(up, ports) {
  try {
    fs.writeFileSync(EDGE_STATE_PATH, JSON.stringify({
      up: up === true,
      ts: Date.now(),
      ports: Array.isArray(ports) ? ports : []
    }));
  } catch {}
}

function edgeStateFresh() {
  try {
    const j = JSON.parse(fs.readFileSync(EDGE_STATE_PATH, 'utf8'));
    const age = Date.now() - Number(j && j.ts || 0);
    return !!(j && j.up === true && age >= 0 && age < 45000 && Array.isArray(j.ports) && j.ports.length);
  } catch {
    return false;
  }
}

function blockReason() {
  try {
    if (!isEnabled()) return '';
    try {
      if (require('./phoneProxyEdge').isUp()) return '';
    } catch {}
    if (edgeStateFresh()) return '';
    return 'phone_pipe_down';
  } catch {
    return 'phone_pipe_down';
  }
}

function sessionOf(nome) {
  return hostId() + '::' + String(nome || '').trim();
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

function rememberWait(nome, purpose) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(WAIT_PATH, 'utf8')); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  if (!rows.some((row) => row && row.nome === nome && row.purpose === purpose)) {
    rows.push({ nome, purpose, at: Date.now() });
  }
  try { fs.writeFileSync(WAIT_PATH, JSON.stringify(rows)); } catch {}
}

function forgetWait(nome) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(WAIT_PATH, 'utf8')); } catch { return; }
  if (!Array.isArray(rows)) return;
  try { fs.writeFileSync(WAIT_PATH, JSON.stringify(rows.filter((row) => row && row.nome !== nome))); } catch {}
}

function startHold(cfg, session) {
  const sess = String(session || '').trim();
  if (!sess) return null;
  let u;
  try { u = new URL(httpBase(cfg.wsUrl) + '/api/phone-proxy/session/' + encodeURIComponent(sess) + '/hold'); }
  catch { return null; }
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname,
    method: 'GET',
    headers: { 'x-phone-proxy-secret': String(cfg.secret || '') }
  });
  req.on('response', (res) => { res.on('data', () => {}); });
  req.on('error', () => {});
  req.end();
  return req;
}

async function resolveLaunch(nome, purpose) {
  const cfg = readConfig();
  if (!cfg) return null;
  const who = String(nome || '').trim();
  if (!who) throw new Error('phone_proxy_required:missing_profile');
  const prev = holds.get(who);
  if (prev && !prev.external && prev.port) return takeForLaunch(nome, purpose);
  if (prev && prev.external && prev.proxyServer) {
    prev.refs += 1;
    return {
      proxyServer: prev.proxyServer,
      host: prev.host,
      port: prev.port,
      username: prev.username,
      password: prev.password,
      external: true
    };
  }
  let route = null;
  try {
    route = await postJson(httpBase(cfg.wsUrl) + '/api/phone-proxy/route', cfg.secret, { hostId: hostId() });
  } catch {
    route = null;
  }
  if (route && route.kind === 'static' && route.proxyServer) {
    holds.set(who, {
      host: String(route.host || ''),
      port: Number(route.port) || 0,
      username: String(route.username || ''),
      password: String(route.password || ''),
      refs: 1,
      session: '',
      holdReq: null,
      external: true,
      proxyServer: String(route.proxyServer)
    });
    note('proxy_static', { nome: who, via: 'static', id: String(route.id || ''), port: Number(route.port) || 0 });
    return {
      proxyServer: String(route.proxyServer),
      host: String(route.host || ''),
      port: Number(route.port) || 0,
      username: String(route.username || ''),
      password: String(route.password || ''),
      external: true
    };
  }
  return takeForLaunch(nome, purpose);
}

async function takeForLaunch(nome, purpose) {
  const cfg = readConfig();
  if (!cfg) return null;
  const who = String(nome || '').trim();
  if (!who) {
    const err = new Error('phone_proxy_required:missing_profile');
    throw err;
  }
  const blocked = blockReason();
  if (blocked) {
    note('phone_proxy_lease', { nome: who, purpose: purpose === 'publish' ? 'publish' : 'visit', via: 'phone', ok: false, error: blocked });
    throw new Error('phone_proxy_required:' + blocked);
  }
  const prev = holds.get(who);
  if (prev && prev.port) {
    if (prev.keep === true) {
      if (!prev.holdReq && !prev.external) {
        prev.holdReq = startHold(cfg, prev.session || sessionOf(who));
      }
      return {
        proxyServer: `http://127.0.0.1:${prev.port}`,
        port: prev.port,
        username: prev.username,
        password: prev.password
      };
    }
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
  const kind = purpose === 'publish' ? 'publish' : 'visit';
  const session = hostId() + '::' + who;
  const leased = await postJson(base + '/api/phone-proxy/lease', secret, {
    hostId: hostId(),
    profile: who,
    purpose: kind,
    session
  });
  const denied = !leased || leased.ok !== true || !leased.port;
  const noChair = !!(leased && (leased.status === 'no_chair' || leased.error === 'no_chair'));
  if (denied) {
    const why = noChair ? 'no_chair' : String((leased && leased.error) || 'lease_failed');
    if (noChair) rememberWait(who, kind);
    note('phone_proxy_lease', {
      nome: who,
      purpose: kind,
      via: 'phone',
      ok: false,
      error: why,
      queued: noChair || (leased && leased.queued === true),
      position: leased && leased.position ? leased.position : null
    });
    throw new Error('phone_proxy_required:' + why);
  }
  const phone = localPhone(cfg, leased.port);
  if (!phone) {
    note('phone_proxy_lease', { nome: who, purpose: kind, via: 'phone', ok: false, error: 'missing_password', port: Number(leased.port) });
    try { await postJson(base + '/api/phone-proxy/release', secret, { hostId: hostId(), profile: who, session }); } catch {}
    throw new Error('phone_proxy_required:missing_password');
  }
  forgetWait(who);
  holds.set(who, {
    port: phone.port,
    username: phone.username,
    password: phone.password,
    refs: 1,
    session: String(leased.session || session),
    keep: false,
    holdReq: startHold(cfg, String(leased.session || session))
  });
  note('phone_proxy_lease', {
    nome: who,
    purpose: purpose === 'publish' ? 'publish' : 'visit',
    via: 'phone',
    ok: true,
    port: phone.port,
    id: phone.id || ''
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
  if (!row || (!row.username && !row.password)) return null;
  return { username: row.username || '', password: row.password || '', port: row.port };
}

function sessionHeld(nome) {
  const row = holds.get(String(nome || '').trim());
  return !!(row && row.keep === true && row.port);
}

async function release(nome) {
  const who = String(nome || '').trim();
  const row = holds.get(who);
  if (!row) return;
  if (row.keep === true) return;
  row.refs -= 1;
  if (row.refs > 0) return;
  holds.delete(who);
  if (row.external) {
    note('proxy_static_release', { nome: who });
    return;
  }
  try { if (row.holdReq) row.holdReq.destroy(); } catch {}
  note('phone_proxy_release', { nome: who, port: row.port });
  const cfg = readConfig();
  if (!cfg) return;
  try {
    await postJson(httpBase(cfg.wsUrl) + '/api/phone-proxy/release', cfg.secret, {
      hostId: hostId(),
      profile: who,
      session: row.session || (hostId() + '::' + who)
    });
  } catch {}
}

async function awaitChair(nome) {
  const who = String(nome || '').trim();
  while (true) {
    try {
      const launch = await takeForLaunch(who, 'publish');
      if (!launch) throw new Error('phone_proxy_required:disabled');
      if (launch.port) {
        const row = holds.get(who);
        if (row && !row.external) row.keep = true;
        return launch;
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      const wait = msg.indexOf('no_chair') >= 0 || msg.indexOf('phone_pipe_down') >= 0 || msg.indexOf('no_carrier') >= 0 || msg.indexOf('lease_failed') >= 0;
      if (!wait) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function releaseSession(nome) {
  const who = String(nome || '').trim();
  const row = holds.get(who);
  if (!row) return;
  row.keep = false;
  row.refs = 1;
  return release(who);
}

async function openForCadastro(nome, browser) {
  if (!isEnabled()) return { ok: true, skipped: 'disabled' };
  let mode = '';
  try { mode = require('./proxyMode').read(); } catch {}
  if (mode !== 'phone') return { ok: true, skipped: 'direct_network' };
  const sw = browser && browser.__ctDirectSwitch;
  if (!sw || typeof sw.flip !== 'function' || typeof sw.port !== 'function') {
    throw new Error('phone_proxy_required:switch');
  }
  const rail = require('./robeRail');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const hop = await hopForPublish(nome);
    sw.flip(hop);
    await new Promise((r) => setTimeout(r, 1500));
    let raw = '';
    try {
      raw = await rail.proveThroughRail(sw.port());
    } catch {
      try { sw.flip(null); } catch {}
      await releaseSession(nome);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed) {
      const blob = String(raw || '').match(/\{[\s\S]*\}/);
      if (blob) { try { parsed = JSON.parse(blob[0]); } catch {} }
    }
    const seen = rail.readExit(parsed);
    if (!seen.ip || seen.asn === 'AS262481') {
      try { sw.flip(null); } catch {}
      await releaseSession(nome);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    note('phone_proxy_cadastro', {
      nome: String(nome || ''),
      ok: true,
      asn: seen.asn,
      country: seen.country,
      ip: seen.ip,
      attempt
    });
    return { ok: true, asn: seen.asn, country: seen.country, ip: seen.ip };
  }
  throw new Error('phone_proxy_required:prove');
}

async function closeForCadastro(nome, browser) {
  const sw = browser && browser.__ctDirectSwitch;
  try { if (sw && typeof sw.flip === 'function') sw.flip(null); } catch {}
  await releaseSession(nome);
  note('phone_proxy_cadastro_release', { nome: String(nome || '') });
}

async function hopForPublish(nome, { deadlineAt = 0 } = {}) {
  while (true) {
    if (deadlineAt > 0 && Date.now() >= deadlineAt) throw new Error('phone_proxy_required:deadline');
    try {
      const launch = await resolveLaunch(nome, 'publish');
      if (launch && launch.external) throw new Error('phone_proxy_required:static_route');
      if (launch && launch.port) {
        return {
          host: '127.0.0.1',
          port: launch.port,
          user: launch.username,
          pass: launch.password
        };
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      const wait = msg.indexOf('no_chair') >= 0 || msg.indexOf('phone_pipe_down') >= 0 || msg.indexOf('no_carrier') >= 0 || msg.indexOf('lease_failed') >= 0;
      if (!wait) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

module.exports = {
  readConfig,
  isEnabled,
  inspect,
  hopForPublish,
  openForCadastro,
  closeForCadastro,
  note,
  writeEdgeState,
  blockReason,
  resolveLaunch,
  takeForLaunch,
  awaitChair,
  heldAuth,
  sessionHeld,
  release,
  releaseSession
};
