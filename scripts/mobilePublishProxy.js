'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const serverConfig = require('./serverConfig.js');
const stepLog = require('./stepLog.js');

const HOST = 'pr.oxylabs.io';
const PORT = 7777;
const ASN = '22085';
const MAX_ATTEMPTS = 5;

function readSettings() {
  let robe = {};
  let ct = {};
  try { robe = (serverConfig.readServerConfigEffective().robe) || {}; } catch {}
  try { ct = require('./ctConfig.js').readCtConfig() || {}; } catch {}
  const enabled = robe.publishWithProxy === true;
  let user = String(ct.oxylabsProxyUser || '').trim();
  if (/^customer-/i.test(user)) user = user.replace(/^customer-/i, '');
  const password = String(ct.oxylabsProxyPassword || '');
  return { enabled, user, password, ready: enabled && !!user && !!password };
}

function operationName(body) {
  const raw = String(body || '');
  const m = raw.match(/(?:fb_api_req_friendly_name|operationName|x-fb-friendly-name)[=:]([^&\r\n]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function headerText(headers) {
  const src = headers && typeof headers === 'object' ? headers : {};
  const entries = Array.isArray(src) ? src : Object.entries(src);
  return entries.map((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry.name;
    const value = Array.isArray(entry) ? entry[1] : entry.value;
    return `${name || ''}:${value || ''}`;
  }).join('\n');
}

function isFacebookHost(url) {
  return /facebook\.com|fbcdn\.net|fb\.com|facebook\.net/i.test(String(url || ''));
}

function classifyPublishRequest({ method, url, postData, headers, publishCaptured }) {
  const verb = String(method || '').toUpperCase();
  const target = String(url || '');
  if (!isFacebookHost(target)) return 'ignore';
  if (publishCaptured) return 'wifi';
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return 'wifi';
  return 'proxy';
}

function isPublishMarked(args) {
  const body = String(args && args.postData || '');
  const op = operationName(body) || operationName(headerText(args && args.headers));
  const blob = `${op}\n${body}\n${headerText(args && args.headers)}`;
  return /Mutation/i.test(op) || /listing.{0,80}create|create.{0,80}listing|ListingCreate|CreateListing|for_sale_item|vehicle_listing|composer.{0,30}publish/i.test(blob);
}

function acceptExit(payload) {
  const asn = String(payload && payload.asn || '');
  const country = String(payload && payload.country || '');
  return asn === `AS${ASN}` && country === 'BR';
}

function curl(args) {
  return new Promise((resolve) => {
    const child = spawn('curl.exe', args, { windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e && e.message || e) }));
    child.on('close', (code) => resolve({
      code: Number(code),
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString('utf8')
    }));
  });
}

function authUser(baseUser, sessid) {
  return `customer-${baseUser}-ASN-${ASN}-sessid-${sessid}-sesstime-15`;
}

function newSessid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function readMeter(stdout) {
  const parts = String(stdout || '').trim().split(/\s+/);
  return {
    http: parts[0] || '',
    up: Number(parts[1]) || 0,
    down: Number(parts[2]) || 0
  };
}

async function probeExit(baseUser, password, sessid) {
  const bodyFile = path.join(os.tmpdir(), `oxy-exit-${sessid}.json`);
  const login = `${authUser(baseUser, sessid)}:${password}`;
  const res = await curl([
    '-sS', '-o', bodyFile, '-w', '%{http_code} %{size_upload} %{size_download}',
    '--max-time', '25',
    '-x', `http://${HOST}:${PORT}`,
    '-U', login,
    'https://ip.oxylabs.io/location'
  ]);
  let parsed = null;
  try {
    const raw = fs.readFileSync(bodyFile, 'utf8');
    parsed = JSON.parse(raw);
  } catch {}
  try { fs.unlinkSync(bodyFile); } catch {}
  const asn = parsed && parsed.providers && parsed.providers.maxmind ? parsed.providers.maxmind.asn : '';
  const country = parsed && parsed.providers && parsed.providers.maxmind ? parsed.providers.maxmind.country : '';
  const ip = parsed && parsed.ip ? String(parsed.ip) : '';
  const meter = readMeter(res.stdout);
  return { http: meter.http, up: meter.up, down: meter.down, ip, asn: String(asn || ''), country: String(country || '') };
}

async function acquireExit(baseUser, password) {
  const tries = [];
  let bytesUp = 0;
  let bytesDown = 0;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const sessid = newSessid();
    const hit = await probeExit(baseUser, password, sessid);
    bytesUp += hit.up;
    bytesDown += hit.down;
    tries.push({ n: i, http: hit.http, asn: hit.asn, country: hit.country, up: hit.up, down: hit.down });
    if (acceptExit(hit)) {
      return { ok: true, sessid, ip: hit.ip, asn: hit.asn, country: hit.country, attempts: i, tries, bytesUp, bytesDown };
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, tries, bytesUp, bytesDown };
}

function headerList(headers) {
  const out = [];
  const src = headers && typeof headers === 'object' ? headers : {};
  const entries = Array.isArray(src) ? src : Object.entries(src);
  for (const entry of entries) {
    const name = Array.isArray(entry) ? entry[0] : entry.name;
    const value = Array.isArray(entry) ? entry[1] : entry.value;
    const key = String(name || '').trim();
    if (!key) continue;
    if (/^(host|content-length|connection|proxy-connection|transfer-encoding)$/i.test(key)) continue;
    out.push([key, String(value == null ? '' : value).replace(/[\r\n]/g, '')]);
  }
  return out;
}

async function replayThroughProxy({ url, method, headers, body, baseUser, password, sessid }) {
  const id = newSessid();
  const bodyFile = path.join(os.tmpdir(), `oxy-pub-body-${id}`);
  const respBody = path.join(os.tmpdir(), `oxy-pub-resp-${id}`);
  const respHead = path.join(os.tmpdir(), `oxy-pub-head-${id}`);
  fs.writeFileSync(bodyFile, Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8'));
  const args = [
    '-sS', '-D', respHead, '-o', respBody, '-w', '%{http_code} %{size_upload} %{size_download}',
    '--max-time', '45',
    '-x', `http://${HOST}:${PORT}`,
    '-U', `${authUser(baseUser, sessid)}:${password}`,
    '-X', method || 'POST',
    '--data-binary', `@${bodyFile}`
  ];
  for (const [name, value] of headerList(headers)) args.push('-H', `${name}: ${value}`);
  args.push(url);
  const res = await curl(args);
  const meter = readMeter(res.stdout);
  const status = Number(meter.http) || 0;
  let resp = Buffer.alloc(0);
  let headTxt = '';
  try { resp = fs.readFileSync(respBody); } catch {}
  try { headTxt = fs.readFileSync(respHead, 'utf8'); } catch {}
  for (const f of [bodyFile, respBody, respHead]) { try { fs.unlinkSync(f); } catch {} }
  const responseHeaders = [];
  for (const line of headTxt.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (/^(transfer-encoding|connection|keep-alive|proxy-authenticate|content-length)$/i.test(name)) continue;
    responseHeaders.push({ name, value });
  }
  return { status, body: resp, responseHeaders, up: meter.up, down: meter.down };
}

async function arm(page, baseUser, password, sessid, nome, meter) {
  const client = await page.target().createCDPSession();
  const note = meter && typeof meter === 'object' ? meter : {};
  const state = { proxied: 0, proxiedAtClick: null, publishCaptured: false, bytesUp: 0, bytesDown: 0, held: [], inflight: 0, closed: false, client };
  state.markClick = () => { state.proxiedAtClick = state.proxied; };
  const patterns = [];
  for (const urlPattern of [
    '*://*.facebook.com/*',
    '*://facebook.com/*',
    '*://*.fbcdn.net/*',
    '*://*.facebook.net/*',
    '*://*.fb.com/*'
  ]) {
    for (const resourceType of ['XHR', 'Fetch', 'Other', 'Media', 'Ping']) {
      patterns.push({ urlPattern, resourceType, requestStage: 'Request' });
    }
  }
  await client.send('Fetch.enable', { patterns });
  const stickyIp = String(note.ip || '');
  state.timer = setInterval(() => {
    if (state.closed || state.publishCaptured) return;
    probeExit(baseUser, password, sessid).then((hit) => {
      if (state.closed || !stickyIp || !hit || !hit.ip) return;
      if (hit.ip !== stickyIp) state.broken = true;
    }).catch(() => {});
  }, 25000);
  client.on('Fetch.requestPaused', async (ev) => {
    if (!ev) return;
    if (state.closed) {
      try { await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); } catch {}
      return;
    }
    state.inflight += 1;
    try { await onPaused(ev); } finally { state.inflight -= 1; }
  });
  async function readPausedBody(ev) {
    const req = ev.request || {};
    const entries = Array.isArray(req.postDataEntries) ? req.postDataEntries : [];
    if (entries.length) {
      const chunks = [];
      for (const entry of entries) {
        if (entry && entry.bytes) chunks.push(Buffer.from(String(entry.bytes), 'base64'));
      }
      if (chunks.length) return Buffer.concat(chunks);
    }
    try {
      const extra = await client.send('Fetch.getRequestPostData', { requestId: ev.requestId });
      if (extra && extra.postData) {
        return extra.base64Encoded
          ? Buffer.from(String(extra.postData), 'base64')
          : Buffer.from(String(extra.postData), 'latin1');
      }
    } catch {}
    if (req.postData) return Buffer.from(String(req.postData), 'latin1');
    return Buffer.alloc(0);
  }
  async function onPaused(ev) {
    const req = ev.request || {};
    const bodyBuf = await readPausedBody(ev);
    const postData = bodyBuf.toString('latin1');
    if (state.broken) {
      try { await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); } catch {}
      return;
    }
    let lane = classifyPublishRequest({
      method: req.method,
      url: req.url,
      postData,
      headers: req.headers,
      publishCaptured: state.publishCaptured === true
    });
    const marked = /graphql|ajax\/bulk/i.test(String(req.url || '')) && isPublishMarked({ postData, headers: req.headers });
    try {
      stepLog.appendJSONL(nome || 'system', 'robe', {
        step: 'proxy_publish_lane',
        lane,
        op: (operationName(postData) || operationName(headerText(req.headers)) || '').slice(0, 140)
      });
    } catch {}
    try {
      if (lane === 'proxy') {
        if (req.hasPostData && !bodyBuf.length) {
          await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionFailed' });
          return;
        }
        const replay = await replayThroughProxy({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: bodyBuf,
          baseUser,
          password,
          sessid
        });
        if (!replay.status) {
          await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionFailed' });
          return;
        }
        await client.send('Fetch.fulfillRequest', {
          requestId: ev.requestId,
          responseCode: replay.status,
          responseHeaders: replay.responseHeaders,
          body: replay.body.toString('base64')
        });
        if (marked) {
          state.publishCaptured = true;
          try { await client.send('Fetch.disable'); } catch {}
        }
        state.proxied += 1;
        state.bytesUp += Number(replay.up) || 0;
        state.bytesDown += Number(replay.down) || 0;
        return;
      }
      await client.send('Fetch.continueRequest', { requestId: ev.requestId });
    } catch {
      try { await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); } catch {}
    }
  }
  state.close = async () => {
    if (state.closed) return;
    state.closed = true;
    try { clearInterval(state.timer); } catch {}
    const waitStart = Date.now();
    while (state.inflight > 0 && (Date.now() - waitStart) < 20000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const fail = state.proxied < 1;
    for (const requestId of state.held) {
      try {
        if (fail) await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        else await client.send('Fetch.continueRequest', { requestId });
      } catch {}
    }
    state.held = [];
    try { await client.send('Fetch.disable'); } catch {}
    try { await client.detach(); } catch {}
    const probeUp = Number(note.bytesUp) || 0;
    const probeDown = Number(note.bytesDown) || 0;
    try {
      stepLog.appendJSONL(nome || 'system', 'robe', {
        step: 'proxy_publish_bytes',
        via: 'proxy',
        ip: note.ip || null,
        asn: note.asn || null,
        country: note.country || null,
        attempts: note.attempts || 0,
        requests: state.proxied,
        publishCaptured: state.publishCaptured === true,
        probeBytesUp: probeUp,
        probeBytesDown: probeDown,
        publishBytesUp: state.bytesUp,
        publishBytesDown: state.bytesDown,
        bytesTotal: probeUp + probeDown + state.bytesUp + state.bytesDown
      });
    } catch {}
  };
  return state;
}

async function openForPublish(page, nome) {
  const cfg = readSettings();
  const idle = { required: false, ok: true, attempts: 0, sent() { return false; }, async close() {} };
  if (!cfg.enabled) {
    try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'proxy_publish_off', via: 'wifi', bytesTotal: 0 }); } catch {}
    return idle;
  }
  if (!cfg.ready) {
    try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'proxy_publish_no_credentials' }); } catch {}
    return { required: true, ok: false, attempts: 0, sent() { return false; }, async close() {} };
  }
  const exit = await acquireExit(cfg.user, cfg.password);
  try {
    stepLog.appendJSONL(nome || 'system', 'robe', {
      step: exit.ok ? 'proxy_publish_exit_ok' : 'proxy_publish_exit_fail',
      attempts: exit.attempts,
      asn: exit.asn || null,
      country: exit.country || null,
      ip: exit.ip || null
    });
  } catch {}
  if (!exit.ok) {
    return { required: true, ok: false, attempts: exit.attempts, sent() { return false; }, async close() {} };
  }
  let gate = null;
  return {
    required: true,
    ok: true,
    attempts: exit.attempts,
    ip: exit.ip,
    async arm() {
      if (!gate) gate = await arm(page, cfg.user, cfg.password, exit.sessid, nome, exit);
    },
    markPublishClick() { if (gate && gate.markClick) gate.markClick(); },
    sent() {
      if (!gate) return false;
      if (gate.publishCaptured === true) return true;
      if (gate.proxiedAtClick == null) return gate.proxied > 0;
      return gate.proxied > gate.proxiedAtClick;
    },
    async close() { if (gate) await gate.close(); }
  };
}

const creationByPage = new WeakMap();

async function beginCreation(page, nome) {
  const existing = creationByPage.get(page);
  if (existing) return existing;
  const opened = await openForPublish(page, nome);
  if (opened.required && opened.ok) await opened.arm();
  creationByPage.set(page, opened);
  return opened;
}

function currentCreation(page) {
  return creationByPage.get(page) || null;
}

async function endCreation(page) {
  const opened = creationByPage.get(page);
  if (!opened) return;
  creationByPage.delete(page);
  try { await opened.close(); } catch {}
}

module.exports = {
  classifyPublishRequest,
  isPublishMarked,
  acceptExit,
  operationName,
  MAX_ATTEMPTS,
  ASN,
  openForPublish,
  beginCreation,
  currentCreation,
  endCreation
};
