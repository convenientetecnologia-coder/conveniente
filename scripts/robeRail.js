'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const mobile = require('./mobilePublishProxy.js');
const chromeMotores = require('./chromeMotores.js');
const { injectCookies, newPageDaConta } = require('./browser.js');
const stepLog = require('./stepLog.js');

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

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

async function openRobeRail({ nome, cookies }) {
  const rail = createSwitch();
  let browser = null;
  let userDataDir = '';
  try {
    const port = await rail.listen();
    userDataDir = path.join(os.tmpdir(), `ct-robe-rail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    const executablePath = chromeMotores.resolveLaunchExeOrFatal();
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      defaultViewport: null,
      protocolTimeout: 120000,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        `--proxy-server=127.0.0.1:${port}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--lang=pt-BR'
      ]
    });
    browser.__ctRobeRail = null;
    const seed = await newPageDaConta(browser, nome, { source: 'robe_rail_seed' });
    await injectCookies(seed, Array.isArray(cookies) ? cookies : []);
    await seed.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    try { stepLog.appendJSONL(nome || 'system', 'robe', { step: 'robe_rail_open', port }); } catch {}
    const api = {
      browser,
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

module.exports = { openRobeRail, readExit };
