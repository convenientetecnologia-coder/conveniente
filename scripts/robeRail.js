'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  injectCookies,
  newPageDaConta,
  blindarPaginaDaConta,
  accountPuppeteer,
  accountChromeLaunchConfig,
  primeAccountStealth,
  prepareAccountChromeProfile,
  maximizeAccountWindow,
  ensureRobeProfile,
  releaseProfileLocks
} = require('./browser.js');
const stepLog = require('./stepLog.js');

const STORAGE_ORIGINS = [
  'https://www.facebook.com',
  'https://web.facebook.com',
  'https://m.facebook.com',
  'https://www.messenger.com'
];
const STORAGE_JSON_MAX = 1200000;

function readExit(payload) {
  const maxmind = payload && payload.providers && payload.providers.maxmind ? payload.providers.maxmind : {};
  return {
    asn: String(maxmind.asn || ''),
    country: String(maxmind.country || ''),
    ip: payload && payload.ip ? String(payload.ip) : ''
  };
}

function createSwitch({ connectTimeoutMs = 30000, requireProxy = false } = {}) {
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1) throw Error('invalid_connect_timeout');
  const sockets = new Set();
  let upstream = null;
  let bytesToProxy = 0;
  const traffic = { directUp: 0, directDown: 0, proxyUp: 0, proxyDown: 0 };
  let boundPort = 0;
  const server = http.createServer();
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.on('error', () => {});
  server.on('request', (_req, res) => {
    try { res.writeHead(405); res.end(); } catch {}
  });

  function track(socket) {
    if (!socket) return;
    sockets.add(socket);
    socket.setTimeout(0);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { try { socket.destroy(); } catch {} });
  }

  function cut() {
    for (const socket of Array.from(sockets)) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
  }

  server.on('connect', (req, client, head) => {
    track(client);
    const raw = String(req.url || '');
    const colon = raw.lastIndexOf(':');
    const host = colon > 0 ? raw.slice(0, colon) : raw;
    const port = colon > 0 ? Number(raw.slice(colon + 1)) || 443 : 443;
    const hop = upstream;
    if (!hop && requireProxy) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let dest;
    let established = false;
    let failed = false;
    const timer = setTimeout(() => fail(), connectTimeoutMs);
    timer.unref();
    const fail = () => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      if (!client.destroyed) {
        if (established) client.destroy();
        else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      if (dest) dest.destroy();
    };
    // Ler FIN/cancelamento enquanto o CONNECT aguarda upstream, sem perder
    // bytes TLS antecipados nem permitir buffer ilimitado antes do HTTP 200.
    const earlyData = chunk => {
      if ((head?.length || 0) + chunk.length > 65536) { fail(); return; }
      head = head?.length ? Buffer.concat([head, chunk]) : chunk;
    };
    client.on('data', earlyData);
    client.on('end', () => { if (!established) fail(); });
    client.resume();
    const bindDestination = socket => {
      dest = socket;
      track(dest);
      client.on('close', () => { clearTimeout(timer); dest.destroy(); });
      dest.on('error', fail);
      dest.on('end', () => { if (!established) fail(); });
      dest.on('close', () => {
        clearTimeout(timer);
        if (!established) fail();
        else if (!dest.readableEnded && !client.destroyed) client.destroy();
      });
    };
    const connected = () => {
      if (failed || client.destroyed) { dest.destroy(); return false; }
      established = true;
      clearTimeout(timer);
      client.removeListener('data', earlyData);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      return true;
    };
    if (!hop) {
      bindDestination(net.connect(port, host));
      dest.on('connect', () => {
        if (!connected()) return;
        if (head && head.length) { traffic.directUp += head.length; dest.write(head); }
        client.on('data', chunk => { traffic.directUp += chunk.length; });
        dest.on('data', chunk => { traffic.directDown += chunk.length; });
        dest.pipe(client);
        client.pipe(dest);
      });
      return;
    }
    bindDestination(net.connect(hop.port, hop.host));
    dest.on('data', chunk => { traffic.proxyDown += chunk.length; });
    let buf = Buffer.alloc(0);
    const onProxyResponse = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) { if (buf.length > 16384) fail(); return; }
      if (idx > 16384) { fail(); return; }
      dest.removeListener('data', onProxyResponse);
      const header = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/i.test(header)) { fail(); return; }
      if (!connected()) return;
      if (rest.length) client.write(rest);
      if (head && head.length) { bytesToProxy += head.length; traffic.proxyUp += head.length; dest.write(head); }
      dest.pipe(client);
      client.on('data', (chunk) => {
        if (chunk && chunk.length) { bytesToProxy += chunk.length; traffic.proxyUp += chunk.length; }
      });
      client.pipe(dest);
    };
    dest.on('data', onProxyResponse);
    dest.on('connect', () => {
      const token = Buffer.from(`${hop.user}:${hop.pass}`).toString('base64');
      const connectRequest =
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: Basic ${token}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`;
      traffic.proxyUp += Buffer.byteLength(connectRequest);
      dest.write(connectRequest);
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        boundPort = addr && addr.port ? addr.port : 0;
        resolve(boundPort);
      });
    });
  }

  return {
    listen,
    port() { return boundPort; },
    flip(next) { upstream = next || null; cut(); },
    phoneHop: null,
    setPhoneHop(hop) { this.phoneHop = hop || null; if (this.phoneHop) upstream = this.phoneHop; },
    backToDirect() { upstream = this.phoneHop || null; cut(); },
    bytesToProxy() { return bytesToProxy; },
    trafficSnapshot() { return { ...traffic }; },
    close() {
      cut();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function proveThroughRail(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let headerBytes = Buffer.alloc(0), settled = false, agent, request;
    let phase = 'proxy_connect';
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (request) request.destroy(); } catch {}
      try { if (agent) agent.destroy(); } catch {}
      try { sock.destroy(); } catch {}
      if (error) reject(error); else resolve(body);
    };
    const timer = setTimeout(() => finish(new Error('prove_timeout:' + phase)), 20000);
    sock.on('error', error => finish(error));
    const onHead = chunk => {
      headerBytes = Buffer.concat([headerBytes, chunk]);
      const cut = headerBytes.indexOf('\r\n\r\n');
      if (cut < 0) return;
      sock.removeListener('data', onHead);
      const header = headerBytes.subarray(0, cut).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(header)) {
        finish(new Error(header.split('\r\n')[0] || 'prove_connect_failed'));
        return;
      }
      const rest = headerBytes.subarray(cut + 4);
      if (rest.length) sock.unshift(rest);
      phase = 'tls';
      const secure = tls.connect({ socket: sock, servername: 'ip.oxylabs.io' });
      secure.once('secureConnect', () => { phase = 'http_headers'; });
      secure.on('error', error => finish(error));
      agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => secure;
      // IncomingMessage termina ao completar Content-Length/chunked; não espera
      // o túnel TCP fechar, e decodifica os chunks antes de entregar o JSON.
      request = https.request({ hostname: 'ip.oxylabs.io', path: '/location', method: 'GET',
        headers: { Connection: 'close' }, agent }, response => {
        phase = 'http_body';
        if (response.statusCode !== 200) {
          finish(new Error('prove_http_status:' + response.statusCode));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 262144) return finish(new Error('prove_response_too_large'));
          chunks.push(chunk);
        });
        response.on('aborted', () => finish(new Error('prove_http_aborted')));
        response.on('error', error => finish(error));
        response.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', error => finish(error));
      request.end();
    };
    sock.on('data', onHead);
    sock.on('connect', () => sock.write('CONNECT ip.oxylabs.io:443 HTTP/1.1\r\nHost: ip.oxylabs.io:443\r\n\r\n'));
  });
}

function isAccountCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'facebook.com' || d.endsWith('.facebook.com')
    || d === 'fb.com' || d.endsWith('.fb.com')
    || d === 'messenger.com' || d.endsWith('.messenger.com');
}

const LIVE_COOKIE_URLS = [
  'https://www.facebook.com',
  'https://www.facebook.com/messages',
  'https://web.facebook.com',
  'https://m.facebook.com',
  'https://www.messenger.com'
];

async function collectLiveCookies(liveBrowser) {
  const found = [];
  try {
    if (!liveBrowser || typeof liveBrowser.pages !== 'function') return found;
    const pages = await liveBrowser.pages();
    for (const pg of pages || []) {
      let got = [];
      try { got = await pg.cookies(...LIVE_COOKIE_URLS); } catch { got = []; }
      const rows = Array.isArray(got) ? got.filter((c) => c && isAccountCookieDomain(c.domain)) : [];
      if (rows.length > found.length) {
        found.length = 0;
        found.push(...rows);
      }
    }
  } catch {}
  return found;
}

async function setAccountCookies(page, cookies) {
  const cleaned = [];
  for (const c of cookies || []) {
    if (!c || !c.name || c.value == null) continue;
    const domain = String(c.domain || '').trim();
    if (!isAccountCookieDomain(domain)) continue;
    const item = {
      name: String(c.name),
      value: String(c.value),
      domain,
      path: c.path ? String(c.path) : '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure
    };
    if (c.sameSite && /^(Strict|Lax|None)$/.test(String(c.sameSite))) item.sameSite = String(c.sameSite);
    if (item.sameSite === 'None') item.secure = true;
    const exp = Number(c.expires);
    if (Number.isFinite(exp) && exp > 1000000000) item.expires = Math.floor(exp);
    cleaned.push(item);
  }
  let applied = 0;
  for (const item of cleaned) {
    try {
      await page.setCookie(item);
      applied++;
    } catch {}
  }
  return applied;
}

async function readPageStorage(page) {
  try {
    return await page.evaluate(() => {
      const dump = (store) => {
        const out = [];
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            out.push([key, store.getItem(key)]);
          }
        } catch {}
        return out;
      };
      let origin = '';
      try { origin = location.origin; } catch { return null; }
      if (!origin) return null;
      return { origin, local: dump(localStorage), session: dump(sessionStorage) };
    });
  } catch {
    return null;
  }
}

async function captureAccountStorage(liveBrowser) {
  const bag = {};
  try {
    if (!liveBrowser || typeof liveBrowser.pages !== 'function') return bag;
    const pages = await liveBrowser.pages();
    for (const page of pages || []) {
      const row = await readPageStorage(page);
      if (!row || !row.origin) continue;
      if (!STORAGE_ORIGINS.includes(row.origin)) continue;
      const local = Array.isArray(row.local) ? row.local : [];
      const session = Array.isArray(row.session) ? row.session : [];
      if (!local.length && !session.length) continue;
      const prev = bag[row.origin] || { local: [], session: [] };
      if ((local.length + session.length) >= (prev.local.length + prev.session.length)) {
        bag[row.origin] = { local, session };
      }
    }
  } catch {}
  try {
    const encoded = JSON.stringify(bag);
    if (encoded.length > STORAGE_JSON_MAX) {
      for (const origin of Object.keys(bag)) {
        if (bag[origin]) bag[origin].idb = [];
      }
      bag.__idbDropped = true;
    }
  } catch {}
  return bag;
}

function slimStorage(bag) {
  const out = {};
  for (const origin of Object.keys(bag || {})) {
    if (origin.indexOf('https://') !== 0) continue;
    const row = bag[origin] || {};
    out[origin] = {
      local: Array.isArray(row.local) ? row.local : [],
      session: Array.isArray(row.session) ? row.session : []
    };
  }
  return out;
}

async function installStorageHook(page, bag) {
  if (!page || page.__ctStorageHooked) return;
  const slim = slimStorage(bag);
  if (!Object.keys(slim).length) {
    page.__ctStorageHooked = true;
    return;
  }
  await page.evaluateOnNewDocument((byOrigin) => {
    let origin = '';
    try { origin = location.origin; } catch { return; }
    const row = byOrigin && byOrigin[origin];
    if (!row) return;
    try {
      localStorage.clear();
      sessionStorage.clear();
      const local = row.local || [];
      for (let i = 0; i < local.length; i++) localStorage.setItem(local[i][0], local[i][1]);
      const session = row.session || [];
      for (let i = 0; i < session.length; i++) sessionStorage.setItem(session[i][0], session[i][1]);
    } catch {}
  }, slim);
  page.__ctStorageHooked = true;
}

async function soleCreatePage(browser, nome) {
  const pages = await browser.pages();
  const first = pages && pages[0] ? pages[0] : null;
  for (const extra of (pages || []).slice(1)) {
    try { await extra.close({ runBeforeUnload: false }); } catch {}
  }
  let page = first;
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    page = await newPageDaConta(browser, nome, { source: 'robe_rail_create' });
  } else {
    await blindarPaginaDaConta(page, nome, { source: 'robe_rail_create' });
  }
  try { await installStorageHook(page, browser.__ctRobeStorage); } catch {}
  return page;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

const isolatedProfiles = new Set();

async function closeIsolatedBrowser(browser) {
  if (!browser) return;
  const proc = browser.process ? browser.process() : null;
  let timer;
  try {
    // Mesmo no caminho de publicação, encerra a conexão Puppeteer e aguarda o
    // Chrome liberar o perfil antes de entregar esse perfil ao próximo fluxo.
    await Promise.race([
      Promise.resolve().then(() => browser.close()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 3000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (proc && proc.exitCode == null && proc.signalCode == null) await killTree(proc.pid);
}

async function launchIsolatedBrowser(config) {
  for (let attempt = 0; ; attempt++) {
    try { return await accountPuppeteer.launch(config); }
    catch (error) {
      // Apenas abertura: nunca repete publicação, documento ou renovação.
      if (attempt >= 1 || !/The browser is already running for /i.test(String(error && error.message))) throw error;
      releaseProfileLocks(config.userDataDir);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function openRobeRail({ nome, cookies, liveBrowser, purpose = 'publish', proxyRequired = true, deadlineAt = 0 }) {
  const profileKey = String(nome || '').trim();
  if (!profileKey) throw new Error('isolated_profile_required');
  const known=await require('./manifestStore').read(nome);
  const blocked=require('./accountSecurityGate').fromFlags(known?.accountFlags);
  if(blocked)throw Error('account_security:'+blocked);
  if (isolatedProfiles.has(profileKey)) throw new Error('isolated_flow_busy');
  isolatedProfiles.add(profileKey);
  const rail = createSwitch({ requireProxy: proxyRequired });
  let browser = null;
  let userDataDir = '';
  let evidence = null;
  let phoneUsed = false;
  let carrierOperation = null;
  let mobileProof = null;
  const carrierAbort = new AbortController();
  let clickTraffic = null;
  let destroyed = false;
  let activePurpose=purpose,cycleBusy=false;
  try {
    const port = await rail.listen();
    // Acquire the chair and bind the mobile route BEFORE starting Chrome.
    // Startup traffic, create/item, native uploads and publication share it.
    if (proxyRequired) {
      const cp2 = require('./carrierV2/accountOperation');
      await cp2.ensureConfig();
      if (cp2.readConfig() && ['publish','renew','id'].includes(purpose)) {
        carrierOperation = await cp2.begin({ nome, purpose, signal: carrierAbort.signal,
          isReady: async () => !destroyed,
          onWait: status => { try { stepLog.appendJSONL(nome,'robe',{step:'carrier_v2_wait',purpose,state:status.state,operationId:status.operationId}); } catch {} }
        });
        rail.flip(carrierOperation.hop);
      } else if (require('./phoneProxyMode').isEnabled()) {
        phoneUsed = true;
        rail.flip(await require('./phoneProxyMode').hopForPublish(nome, { deadlineAt }));
      } else throw Error('phone_proxy_not_configured');
      const raw = await proveThroughRail(port);
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        const match = String(raw).match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }
      mobileProof = readExit(parsed);
      if (!mobileProof.ip) throw Error('mobile_proof_missing');
    }
    const [live, storage] = await Promise.all([
      collectLiveCookies(liveBrowser),
      captureAccountStorage(liveBrowser)
    ]);
    try { await primeAccountStealth(nome); } catch {}
    userDataDir = ensureRobeProfile(nome);
    releaseProfileLocks(userDataDir);
    // Fixed, per-account profile: Chrome validates/reuses disk cache normally.
    // Do not erase cookies, storage or cache on every isolated session.
    prepareAccountChromeProfile(userDataDir);
    const launchConfig = accountChromeLaunchConfig({
      userDataDir,
      proxyServer: `127.0.0.1:${port}`
    });
    if (proxyRequired) launchConfig.args.push('--disable-quic','--proxy-bypass-list=<-loopback>');
    browser = await launchIsolatedBrowser(launchConfig);
    browser.once('disconnected',()=>carrierAbort.abort(Error('isolated_browser_disconnected')));
    browser.__ctRobeStorage = storage;
    const pages = await browser.pages();
    const seed = pages && pages[0] ? pages[0] : await newPageDaConta(browser, nome, { source: 'robe_rail_seed' });
    for (const extra of (pages || []).slice(1)) {
      try { await extra.close({ runBeforeUnload: false }); } catch {}
    }
    try { await maximizeAccountWindow(seed); } catch {}
    await blindarPaginaDaConta(seed, nome, { source: 'robe_rail_seed' });
    let cookieCount = 0;
    let cookieSource = 'manifest';
    if (live.length) {
      cookieCount = await setAccountCookies(seed, live);
      if (cookieCount) cookieSource = 'live';
    }
    if (!cookieCount) {
      await injectCookies(seed, Array.isArray(cookies) ? cookies : []);
      cookieCount = Array.isArray(cookies) ? cookies.length : 0;
      cookieSource = 'manifest';
    }
    await installStorageHook(seed, storage);
    const www = storage && storage['https://www.facebook.com'] ? storage['https://www.facebook.com'] : {};
    try {
      stepLog.appendJSONL(nome || 'system', 'robe', {
        step: 'robe_rail_open',
        port,
        cookies: cookieCount,
        cookieSource,
        local: Array.isArray(www.local) ? www.local.length : 0,
        session: Array.isArray(www.session) ? www.session.length : 0,
        profile: 'fixed',
        browserRole: 'robe_isolated',
        purpose,
        proxyRequired,
        exitIp: mobileProof?.ip || null,
        exitAsn: mobileProof?.asn || null,
        exitCountry: mobileProof?.country || null,
        robePid: browser.process && browser.process() ? browser.process().pid : null,
        virtusPid: liveBrowser && liveBrowser.process && liveBrowser.process() ? liveBrowser.process().pid : null
      });
    } catch {}
    const api = {
      browser,
      purpose,
      operationSnapshot:()=>carrierOperation?.snapshot()||null,
      async withStage(kind,action){
        if(purpose!=='publish'||!['id','renew','virtus'].includes(kind)||cycleBusy)throw Error('account_cycle_stage_busy');
        const state=carrierOperation?.snapshot();
        if(state&&(state.healthy===false||state.sent&&state.result!=='confirmed'))throw Error('account_cycle_previous_stage_unconfirmed');
        const limit=state?.absoluteDeadline?state.absoluteDeadline*1000:Date.now()+1200000;
        if(limit-Date.now()<30000)throw Error('account_cycle_budget_exhausted');
        cycleBusy=true;const previous=browser.__ctIsolatedFlow;
        activePurpose=kind;if(evidence){evidence.cleanup();evidence=null;}clickTraffic=null;
        browser.__ctIsolatedFlow={kind,proxyRequired,rail:api,deadlineAt:limit-5000,shared:true};
        try{stepLog.appendJSONL(nome,'robe',{step:'account_cycle_stage_begin',kind,operationId:state?.operationId||null});return await action();}
        finally{if(evidence){evidence.cleanup();evidence=null;}activePurpose=purpose;browser.__ctIsolatedFlow=previous;cycleBusy=false;}
      },
      proxyRequired,
      borrowLease(){
        if(!carrierOperation||activePurpose!=='virtus'||destroyed)throw Error('account_cycle_borrow_not_allowed');
        return {accountId:nome,operationId:carrierOperation.operationId,hop:carrierOperation.hop,
          snapshot:()=>({...carrierOperation.snapshot(),healthy:!destroyed&&carrierOperation.snapshot().healthy}),
          possibleSideEffect:()=>carrierOperation.possibleSideEffect('virtus'),confirm:()=>carrierOperation.confirm(),close:async()=>{}};
      },
      async checkVirtus(session){
        if(!carrierOperation)return {ok:true,skipped:true,reason:'shared_lease_unavailable'};
        return api.withStage('virtus',async()=>{
          for(const work of await browser.pages())try{await work.setOfflineMode(true)}catch{}
          return session.visitOnLease(api.borrowLease());
        });
      },
      isProxyArmed: proxyRequired && !!mobileProof,
      async armAndProve(page) {
        if (!proxyRequired) return { ok: true, skipped: true, provider: 'direct' };
        if (destroyed || carrierAbort.signal.aborted || !browser.isConnected() || page.isClosed()) throw Error('mobile_session_closed');
        if (!api.isProxyArmed || !mobileProof) throw Error('mobile_route_not_armed');
        if (carrierOperation?.snapshot().healthy === false) throw Error('mobile_transport_not_healthy');
        await require('./accountSecurityGate').assertAllowed(page,nome);
    await require('./workAuthentication').assertAuthenticated(page,nome);
        if (!evidence && (activePurpose === 'publish' || activePurpose === 'renew')) evidence = require('./robePublishEvidence').watch(page, {operation:activePurpose});
        return { ok: true, provider: carrierOperation ? 'carrier_v2' : 'phone', alreadyArmed: true, ...mobileProof };
      },
      trafficSnapshot() { return rail.trafficSnapshot(); },
      bytesToProxy() { return rail.bytesToProxy(); },
      async markPublishClick() {
        if(carrierOperation)await carrierOperation.possibleSideEffect(activePurpose===purpose?undefined:activePurpose==='id'?'identity':activePurpose);
        clickTraffic = rail.trafficSnapshot();
        if (evidence) evidence.arm();
        stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_publish_click', purpose:activePurpose, trafficBeforeClick: clickTraffic });
      },
      async waitPublishTransport() {
        const until = Date.now() + 30000;
        let snap = evidence ? evidence.snapshot() : {};
        while (Date.now() < until && (!snap.finished || snap.bodyPending) && !snap.failed) {
          await new Promise(resolve => setTimeout(resolve, 100));
          snap = evidence ? evidence.snapshot() : {};
        }
        const total = rail.trafficSnapshot();
        const afterClick = clickTraffic ? {
          up: total.proxyUp - clickTraffic.proxyUp,
          down: total.proxyDown - clickTraffic.proxyDown
        } : null;
        const confirmed = activePurpose === 'renew' ? snap.operationConfirmed === true : snap.creationConfirmed === true;
        const result = { ok: snap.transportOk === true && confirmed, ...snap, purpose:activePurpose, traffic: total, afterClick, provider: 'phone' };
        if(result.ok&&carrierOperation)carrierOperation.confirm();
        stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_publish_transport', ...result });
        return result;
      },
      async backToDirect() {
        // Compatibility with callers that used to switch after publishing.
        // A mobile session stays mobile until its browser is closed.
        if (proxyRequired) return;
        if (purpose === 'id' && proxyRequired) throw new Error('identity_proxy_required_until_close');
        const current=carrierOperation?.snapshot();
        if(current?.sent&&current.result!=='confirmed')throw Error('cp2_unknown_keep_proxy_until_close');
        rail.backToDirect();
        api.isProxyArmed = false;
        try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_direct' }); } catch {}
      },
      async releaseProxy() {
        // Mobile sessions release their chair only after the browser closes.
        if (proxyRequired) return;
        await api.backToDirect();
        if(carrierOperation){await carrierOperation.close();carrierOperation=null}
        if (phoneUsed) await require('./phoneProxyMode').releaseSession(nome);
        phoneUsed = false;
      },
      async destroy(opts) {
        if (destroyed) return;
        destroyed = true;
        carrierAbort.abort(Error('isolated_flow_closed'));
        if (evidence) evidence.cleanup();
        const proc = browser && browser.process ? browser.process() : null;
        const pid = proc && proc.pid;
        await closeIsolatedBrowser(browser);
        try { await rail.close(); } catch {}
        try { if(carrierOperation)await carrierOperation.close() } catch(error){stepLog.appendJSONL(nome,'robe',{step:'carrier_v2_close_pending',purpose,error:String(error.message||error)})}
        try { if (phoneUsed) await require('./phoneProxyMode').releaseSession(nome); } catch {}
        try { releaseProfileLocks(userDataDir); } catch {}
        isolatedProfiles.delete(profileKey);
        try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_dead', purpose, pid: pid || null, kept: true, traffic: rail.trafficSnapshot() }); } catch {}
      }
    };
    api.markIdentityStart=async()=>{if(carrierOperation)await carrierOperation.possibleSideEffect(purpose==='publish'?'identity':undefined)};
    api.confirmIdentity=()=>{if(carrierOperation)carrierOperation.confirm(purpose==='publish'?'identity':undefined)};
    browser.__ctRobeRail = api;
    browser.__ctIsolatedFlow = { kind: purpose, proxyRequired, rail: api };
    return api;
  } catch (e) {
    const error = String(e?.message || e).slice(0,180);
    try { stepLog.appendJSONL(nome || 'system','robe',{step:'carrier_v2_admission_failed',purpose,error,code:String(e?.code||''),cause:String(e?.cause?.code||'')}); } catch {}
    if (evidence) evidence.cleanup();
    try { await closeIsolatedBrowser(browser); } catch {}
    try { await rail.close(); } catch {}
    try { if (carrierOperation) await carrierOperation.close(); } catch {}
    try { if (phoneUsed) await require('./phoneProxyMode').releaseSession(nome); } catch {}
    try { if (userDataDir) releaseProfileLocks(userDataDir); } catch {}
    isolatedProfiles.delete(profileKey);
    throw e;
  }
}

module.exports = { openRobeRail, readExit, soleCreatePage, proveThroughRail, createDirectSwitch: createSwitch };
