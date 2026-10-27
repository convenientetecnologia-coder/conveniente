'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mobile = require('./mobilePublishProxy.js');
const chromeHeap = require('./chromeHeapFaxina.js');
const {
  injectCookies,
  newPageDaConta,
  blindarPaginaDaConta,
  accountPuppeteer,
  accountChromeLaunchConfig,
  primeAccountStealth,
  prepareAccountChromeProfile,
  maximizeAccountWindow
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

function createSwitch() {
  const sockets = new Set();
  let upstream = null;
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
    if (!hop) {
      const dest = net.connect(port, host);
      track(dest);
      dest.on('connect', () => {
        try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch {}
        if (head && head.length) dest.write(head);
        dest.pipe(client);
        client.pipe(dest);
      });
      return;
    }
    const dest = net.connect(hop.port, hop.host);
    track(dest);
    let buf = Buffer.alloc(0);
    const fail = () => {
      try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      try { dest.destroy(); } catch {}
    };
    dest.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      dest.removeAllListeners('data');
      const header = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/i.test(header)) { fail(); return; }
      try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch {}
      if (rest.length) dest.unshift(rest);
      if (head && head.length) dest.write(head);
      dest.pipe(client);
      client.pipe(dest);
    });
    dest.on('connect', () => {
      const token = Buffer.from(`${hop.user}:${hop.pass}`).toString('base64');
      dest.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: Basic ${token}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`
      );
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr && addr.port);
      });
    });
  }

  return {
    listen,
    flip(next) { upstream = next || null; cut(); },
    backToDirect() { upstream = null; cut(); },
    close() {
      cut();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function proveThroughRail(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch {}
      reject(new Error('prove_timeout'));
    }, 20000);
    const fail = (err) => {
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      reject(err);
    };
    sock.on('error', fail);
    const onHead = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      sock.removeListener('data', onHead);
      const header = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/i.test(header)) {
        fail(new Error(header.split('\r\n')[0] || 'prove_connect_failed'));
        return;
      }
      if (rest.length) sock.unshift(rest);
      const secure = tls.connect({ socket: sock, servername: 'ip.oxylabs.io' }, () => {
        secure.write('GET /location HTTP/1.1\r\nHost: ip.oxylabs.io\r\nConnection: close\r\n\r\n');
      });
      let body = Buffer.alloc(0);
      secure.on('data', (c) => { body = Buffer.concat([body, c]); });
      secure.on('error', fail);
      secure.on('end', () => {
        clearTimeout(timer);
        const text = body.toString('utf8');
        const cut = text.indexOf('\r\n\r\n');
        resolve(cut >= 0 ? text.slice(cut + 4) : text);
      });
    };
    sock.on('data', onHead);
    sock.on('connect', () => {
      sock.write('CONNECT ip.oxylabs.io:443 HTTP/1.1\r\nHost: ip.oxylabs.io:443\r\n\r\n');
    });
  });
}

function isAccountCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'facebook.com' || d.endsWith('.facebook.com')
    || d === 'fb.com' || d.endsWith('.fb.com')
    || d === 'messenger.com' || d.endsWith('.messenger.com');
}

async function collectLiveCookies(liveBrowser) {
  const found = [];
  try {
    if (!liveBrowser || typeof liveBrowser.pages !== 'function') return found;
    const pages = await liveBrowser.pages();
    for (const pg of pages || []) {
      const got = await chromeHeap.withEphemeralCdpSession(pg, async (client) => {
        const res = await client.send('Network.getAllCookies');
        return Array.isArray(res && res.cookies) ? res.cookies : [];
      });
      const rows = Array.isArray(got) ? got.filter((c) => c && isAccountCookieDomain(c.domain)) : [];
      if (rows.length > found.length) {
        found.length = 0;
        found.push(...rows);
      }
    }
  } catch {}
  if (found.length) return found;
  try {
    const pages = await liveBrowser.pages();
    for (const pg of pages || []) {
      let got = [];
      try { got = await pg.cookies('https://www.facebook.com'); } catch {}
      if (Array.isArray(got) && got.length > found.length) {
        found.length = 0;
        found.push(...got);
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

async function readDomStorage(page, origin, isLocalStorage) {
  try {
    const entries = await chromeHeap.withEphemeralCdpSession(page, async (client) => {
      await client.send('DOMStorage.enable');
      try {
        const res = await client.send('DOMStorage.getDOMStorageItems', {
          storageId: { securityOrigin: origin, isLocalStorage: !!isLocalStorage }
        });
        return res && Array.isArray(res.entries) ? res.entries : [];
      } catch {
        const res = await client.send('DOMStorage.getDOMStorageItems', {
          storageId: { storageKey: origin, isLocalStorage: !!isLocalStorage }
        });
        return res && Array.isArray(res.entries) ? res.entries : [];
      }
    });
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function dumpIndexedDb(page) {
  const dumped = await Promise.race([
    page.evaluate(async () => {
      const out = [];
      if (!indexedDB || typeof indexedDB.databases !== 'function') return out;
      const dbs = await indexedDB.databases();
      for (const info of dbs || []) {
        if (!info || !info.name) continue;
        const one = await new Promise((resolve) => {
          let settled = false;
          const done = (value) => { if (!settled) { settled = true; resolve(value); } };
          const req = indexedDB.open(info.name);
          req.onerror = () => done(null);
          req.onsuccess = () => {
            const db = req.result;
            const names = Array.from(db.objectStoreNames || []);
            if (!names.length) {
              const version = db.version || info.version || 1;
              db.close();
              done({ name: info.name, version, stores: {} });
              return;
            }
            let tx;
            try { tx = db.transaction(names, 'readonly'); } catch { db.close(); done(null); return; }
            const stores = {};
            let left = names.length;
            const finishOne = () => {
              left -= 1;
              if (left > 0) return;
              const version = db.version || info.version || 1;
              try { db.close(); } catch {}
              done({ name: info.name, version, stores });
            };
            tx.onerror = () => { try { db.close(); } catch {} done(null); };
            for (const name of names) {
              try {
                const store = tx.objectStore(name);
                const meta = { keyPath: store.keyPath || null, autoIncrement: !!store.autoIncrement, rows: [] };
                const all = store.getAll();
                const keys = store.getAllKeys();
                let values = null;
                let ks = null;
                let storeDone = false;
                const finishStore = () => {
                  if (storeDone) return;
                  storeDone = true;
                  finishOne();
                };
                const pack = () => {
                  if (!values || !ks) return;
                  const n = Math.min(values.length, ks.length);
                  for (let i = 0; i < n; i++) {
                    try {
                      meta.rows.push({
                        key: JSON.parse(JSON.stringify(ks[i])),
                        value: JSON.parse(JSON.stringify(values[i]))
                      });
                    } catch {}
                  }
                  stores[name] = meta;
                  finishStore();
                };
                all.onsuccess = () => { values = all.result || []; pack(); };
                keys.onsuccess = () => { ks = keys.result || []; pack(); };
                all.onerror = () => finishStore();
                keys.onerror = () => finishStore();
              } catch {
                finishOne();
              }
            }
          };
        });
        if (one) out.push(one);
      }
      return out;
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 8000))
  ]);
  return Array.isArray(dumped) ? dumped : [];
}

async function captureAccountStorage(liveBrowser) {
  const bag = {};
  try {
    if (!liveBrowser || typeof liveBrowser.pages !== 'function') return bag;
    const pages = await liveBrowser.pages();
    const page = (pages || []).find((p) => p) || null;
    if (!page) return bag;
    for (const origin of STORAGE_ORIGINS) {
      const local = await readDomStorage(page, origin, true);
      const session = await readDomStorage(page, origin, false);
      if ((local && local.length) || (session && session.length)) {
        bag[origin] = { local: local || [], session: session || [], idb: [] };
      }
    }
    for (const pg of pages || []) {
      let origin = '';
      try { origin = new URL(pg.url()).origin; } catch { origin = ''; }
      if (!STORAGE_ORIGINS.includes(origin)) continue;
      const idb = await dumpIndexedDb(pg);
      if (!idb.length) continue;
      if (!bag[origin]) bag[origin] = { local: [], session: [], idb: [] };
      bag[origin].idb = idb;
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
      const local = row.local || [];
      for (let i = 0; i < local.length; i++) localStorage.setItem(local[i][0], local[i][1]);
      const session = row.session || [];
      for (let i = 0; i < session.length; i++) sessionStorage.setItem(session[i][0], session[i][1]);
    } catch {}
  }, slim);
  page.__ctStorageHooked = true;
}

async function plantIndexedDb(page, databases) {
  if (!page || !Array.isArray(databases) || !databases.length) return { ok: true, skipped: 'no_idb' };
  await page.goto('https://www.facebook.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const wrote = await Promise.race([
    page.evaluate(async (dbs) => {
      let planted = 0;
      for (const db of dbs || []) {
        if (!db || !db.name) continue;
        try {
          await new Promise((resolve, reject) => {
            const req = indexedDB.open(db.name, db.version || 1);
            req.onerror = () => reject(req.error || new Error('idb_open'));
            req.onupgradeneeded = () => {
              const database = req.result;
              const stores = db.stores || {};
              for (const name of Object.keys(stores)) {
                if (database.objectStoreNames.contains(name)) continue;
                const meta = stores[name] || {};
                const opts = {};
                if (meta.keyPath) opts.keyPath = meta.keyPath;
                if (meta.autoIncrement) opts.autoIncrement = true;
                try { database.createObjectStore(name, opts); } catch {}
              }
            };
            req.onsuccess = () => {
              const database = req.result;
              const names = Object.keys(db.stores || {}).filter((name) => database.objectStoreNames.contains(name));
              if (!names.length) { database.close(); resolve(); return; }
              let tx;
              try { tx = database.transaction(names, 'readwrite'); } catch (e) { database.close(); reject(e); return; }
              for (const name of names) {
                const store = tx.objectStore(name);
                const meta = db.stores[name] || {};
                for (const row of meta.rows || []) {
                  try {
                    if (meta.keyPath) store.put(row.value);
                    else store.put(row.value, row.key);
                  } catch {}
                }
              }
              tx.oncomplete = () => { try { database.close(); } catch {} resolve(); };
              tx.onerror = () => { try { database.close(); } catch {} reject(tx.error || new Error('idb_tx')); };
            };
          });
          planted++;
        } catch {}
      }
      return planted;
    }, databases),
    new Promise((resolve) => setTimeout(() => resolve(0), 8000))
  ]);
  return { ok: true, dbs: Number(wrote) || 0 };
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

async function openRobeRail({ nome, cookies, liveBrowser }) {
  const rail = createSwitch();
  let browser = null;
  let userDataDir = '';
  try {
    const port = await rail.listen();
    const [live, storage] = await Promise.all([
      collectLiveCookies(liveBrowser),
      captureAccountStorage(liveBrowser)
    ]);
    try { await primeAccountStealth(nome); } catch {}
    userDataDir = path.join(os.tmpdir(), `ct-robe-rail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    prepareAccountChromeProfile(userDataDir);
    browser = await accountPuppeteer.launch(accountChromeLaunchConfig({
      userDataDir,
      proxyServer: `127.0.0.1:${port}`
    }));
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
    let storagePlanted = false;
    try {
      stepLog.appendJSONL(nome || 'system', 'robe', {
        step: 'robe_rail_open',
        port,
        cookies: cookieCount,
        cookieSource,
        local: Array.isArray(www.local) ? www.local.length : 0,
        session: Array.isArray(www.session) ? www.session.length : 0,
        idb: Array.isArray(www.idb) ? www.idb.length : 0,
        idbDropped: !!(storage && storage.__idbDropped)
      });
    } catch {}
    const api = {
      browser,
      async plantStorage(page) {
        if (storagePlanted) return { ok: true, skipped: 'already' };
        const idb = www && Array.isArray(www.idb) ? www.idb : [];
        if (!idb.length) {
          storagePlanted = true;
          return { ok: true, skipped: 'no_idb' };
        }
        try {
          const wrote = await plantIndexedDb(page, idb);
          storagePlanted = !!(wrote && wrote.ok);
          try {
            stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_storage', dbs: wrote && wrote.dbs ? wrote.dbs : 0 });
          } catch {}
          return wrote;
        } catch (e) {
          const error = String((e && e.message) || e).slice(0, 180);
          try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_storage_fail', error }); } catch {}
          return { ok: false, error };
        }
      },
      async armAndProve(page) {
        const cfg = mobile.readSettings();
        if (!cfg.ready) return { ok: false, reason: 'no_credentials' };
        const exit = await mobile.acquireExit(cfg.user, cfg.password);
        if (!exit.ok) return { ok: false, reason: 'exit_fail', attempts: exit.attempts || 0 };
        const hop = mobile.upstreamFor(exit.sessid);
        rail.flip(hop);
        await new Promise((r) => setTimeout(r, 500));
        let raw = '';
        try {
          raw = await proveThroughRail(port);
        } catch (e) {
          const error = String((e && e.message) || e).slice(0, 180);
          try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_prove_fail', reason: 'prove_failed', error }); } catch {}
          return { ok: false, reason: 'prove_failed', error };
        }
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        if (!parsed) {
          const blob = String(raw || '').match(/\{[\s\S]*\}/);
          if (blob) { try { parsed = JSON.parse(blob[0]); } catch {} }
        }
        const seen = readExit(parsed);
        if (!mobile.acceptExit(seen)) {
          try {
            stepLog.appendJSONL(nome || 'system', 'robe', {
              step: 'robe_rail_prove_fail',
              reason: 'prove_not_mobile',
              asn: seen.asn,
              country: seen.country,
              ip: seen.ip
            });
          } catch {}
          return { ok: false, reason: 'prove_not_mobile', asn: seen.asn, country: seen.country, ip: seen.ip, attempts: exit.attempts || 0 };
        }
        try {
          stepLog.appendJSONL(nome || 'system', 'robe', {
            step: 'robe_rail_proved',
            asn: seen.asn,
            country: seen.country,
            ip: seen.ip
          });
        } catch {}
        return { ok: true, asn: seen.asn, country: seen.country, ip: seen.ip, attempts: exit.attempts || 0 };
      },
      async backToDirect() {
        rail.backToDirect();
        try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_direct' }); } catch {}
      },
      async destroy() {
        const proc = browser && browser.process ? browser.process() : null;
        const pid = proc && proc.pid;
        try { if (browser) await browser.close(); } catch {}
        await killTree(pid);
        try { await rail.close(); } catch {}
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_dead', pid: pid || null }); } catch {}
      }
    };
    browser.__ctRobeRail = api;
    return api;
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    try {
      const proc = browser && browser.process ? browser.process() : null;
      await killTree(proc && proc.pid);
    } catch {}
    try { await rail.close(); } catch {}
    try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

module.exports = { openRobeRail, readExit, soleCreatePage };
