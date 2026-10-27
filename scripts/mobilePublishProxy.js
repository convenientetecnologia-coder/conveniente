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
  return /ListingCreate|CreateListing|for_sale_item|vehicle_listing|listing.{0,40}create|create.{0,40}listing|composer.{0,30}publish/i.test(blob);
}

function acceptExit(payload) {
  const asn = String(payload && payload.asn || '');
  const country = String(payload && payload.country || '');
  return asn === `AS${ASN}` && country === 'BR';
}

function safeUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.host}${u.pathname}`.slice(0, 180);
  } catch {
    return String(url || '').split('?')[0].slice(0, 180);
  }
}

function headerValue(headers, name) {
  const want = String(name || '').toLowerCase();
  const src = headers && typeof headers === 'object' ? headers : {};
  const entries = Array.isArray(src) ? src : Object.entries(src);
  for (const entry of entries) {
    const key = Array.isArray(entry) ? entry[0] : entry.name;
    const value = Array.isArray(entry) ? entry[1] : entry.value;
    if (String(key || '').toLowerCase() === want) return String(value || '');
  }
  return '';
}

function plain(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isPhotoUploadUrl(url) {
  return /photo\/upload|attachments\/photo|rupload|upload\.facebook|\/ajax\/.*upload|media_upload|composer_photo|upload_photo/i.test(String(url || ''));
}

function bodyHasImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return false;
  const slice = buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024));
  if (slice.indexOf(Buffer.from([0xFF, 0xD8, 0xFF])) >= 0) return true;
  if (slice.indexOf(Buffer.from([0x89, 0x50, 0x4E, 0x47])) >= 0) return true;
  if (slice.indexOf(Buffer.from('RIFF')) >= 0 && slice.indexOf(Buffer.from('WEBP')) >= 0) return true;
  return false;
}

function photoCarriesFile(buf) {
  return Buffer.isBuffer(buf) && (buf.length >= 15000 || bodyHasImage(buf));
}

function multipartBoundary(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (match) return String(match[1] || match[2] || '').trim();
  if (!Buffer.isBuffer(body) || !body.length) return '';
  const line = body.subarray(0, 180).toString('latin1').match(/^--([^\r\n]+)/);
  if (!line || line[1].endsWith('--')) return '';
  return line[1];
}

function multipartFieldNames(body) {
  if (!Buffer.isBuffer(body) || !body.length) return '';
  const text = body.subarray(0, Math.min(body.length, 12000)).toString('latin1');
  const names = [];
  const re = /(?:^|[\s;])name="([^"]+)"/gi;
  let found;
  while ((found = re.exec(text))) {
    const lineStart = Math.max(0, text.lastIndexOf('\n', found.index - 1) + 1);
    const lineEnd = text.indexOf('\n', found.index);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    names.push(/filename\s*=/i.test(line) ? found[1] + ':file' : found[1]);
    if (names.length >= 12) break;
  }
  return names.join(',');
}

function splicePhotoFile(body, contentType, fileBuf) {
  if (!Buffer.isBuffer(body) || !Buffer.isBuffer(fileBuf) || fileBuf.length < 3) return null;
  const boundary = multipartBoundary(body, contentType);
  if (!boundary) return null;
  const sep = Buffer.from('--' + boundary);
  const indexes = [];
  let from = 0;
  while (from < body.length) {
    const at = body.indexOf(sep, from);
    if (at < 0) break;
    indexes.push(at);
    from = at + sep.length;
  }
  if (indexes.length < 2) return null;
  const chunks = [];
  let replaced = false;
  for (let i = 0; i < indexes.length; i++) {
    const at = indexes[i];
    const next = i + 1 < indexes.length ? indexes[i + 1] : body.length;
    let part = body.subarray(at, next);
    const after = body.subarray(at + sep.length, at + sep.length + 2);
    const isClose = after.length >= 2 && after[0] === 45 && after[1] === 45;
    if (!isClose && !replaced) {
      let headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
      let headerLen = 4;
      if (headerEnd < 0) {
        headerEnd = part.indexOf(Buffer.from('\n\n'));
        headerLen = 2;
      }
      if (headerEnd > 0 && /filename\s*=/i.test(part.subarray(0, headerEnd).toString('latin1'))) {
        part = Buffer.concat([
          part.subarray(0, headerEnd + headerLen),
          fileBuf,
          Buffer.from('\r\n')
        ]);
        replaced = true;
      }
    }
    chunks.push(part);
  }
  if (!replaced) {
    chunks.splice(Math.max(0, chunks.length - 1), 0, Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
      fileBuf,
      Buffer.from('\r\n')
    ]));
  }
  const out = Buffer.concat(chunks);
  return bodyHasImage(out) ? out : null;
}

function readPhotoFile(filePath) {
  try {
    if (!filePath) return null;
    const buf = fs.readFileSync(filePath);
    if (buf && buf.length > 100 && bodyHasImage(buf)) return buf;
  } catch {}
  return null;
}

function composerPhotoProblem(text) {
  const t = plain(text);
  if (/nao foi possivel processar|nao foi possivel carregar|nao pode ser processad|could not process|couldn.?t process|could not upload|no se pudo procesar/.test(t)) {
    return 'photo_process_failed';
  }
  return '';
}

function judgePhotoResponse(status, body) {
  const code = Number(status) || 0;
  const head = Buffer.isBuffer(body) ? body.subarray(0, 800).toString('utf8') : String(body || '').slice(0, 800);
  const t = plain(head);
  if (!code) return { ok: false, reason: 'photo_upload_no_status' };
  if (code >= 400) return { ok: false, reason: 'photo_upload_http_' + code };
  if (/1357054|nao foi possivel|nao pode ser processad|could not process|couldn.?t process|photo_upload_error/.test(t)) {
    return { ok: false, reason: 'photo_upload_rejected' };
  }
  return { ok: true, reason: 'photo_upload_ok' };
}

function responseNote(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  const sample = buf.subarray(0, 180);
  let weird = 0;
  for (const b of sample) if (b === 0 || (b > 126 && b < 160)) weird += 1;
  if (weird > 20) return 'binary:' + sample.subarray(0, 8).toString('hex');
  return sample.toString('utf8').replace(/\s+/g, ' ').slice(0, 160);
}

function hideSecret(text, secret) {
  const raw = String(text || '');
  const key = String(secret || '');
  if (key.length < 4) return raw;
  return raw.split(key).join('');
}

function auditReplay(nome, row) {
  try {
    require('./provisionAudit.js').append(Object.assign({
      ts: Date.now(),
      event: 'proxy_publish_replay',
      nome: String(nome || '')
    }, row || {}));
  } catch {}
}

async function readComposerPhotoProblem(page) {
  let text = '';
  try {
    text = await page.evaluate(() => String((document.body && document.body.innerText) || '').slice(0, 6000));
  } catch {}
  return composerPhotoProblem(text);
}

function waitWifiPhotoUpload(page, timeoutMs) {
  const timeout = Math.max(8000, Number(timeoutMs) || 60000);
  return page.waitForResponse((res) => {
    let method = 'GET';
    try { method = String(res.request().method() || 'GET'); } catch {}
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    let url = '';
    try { url = String(res.url() || ''); } catch {}
    return isPhotoUploadUrl(url);
  }, { timeout }).catch(() => null);
}

async function waitComposerPhoto(page, creation, timeoutMs) {
  const timeout = Math.max(8000, Number(timeoutMs) || 170000);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const problem = await readComposerPhotoProblem(page);
    if (problem) return { ok: false, reason: problem, waitedMs: Date.now() - start };
    const net = creation && typeof creation.photoResult === 'function' ? creation.photoResult() : null;
    if (net && net.ok === false) return Object.assign({ waitedMs: Date.now() - start }, net);
    if (net && net.ok === true) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await readComposerPhotoProblem(page);
      if (again) return { ok: false, reason: again, waitedMs: Date.now() - start, status: net.status || null };
      return {
        ok: true,
        reason: net.reason || 'photo_upload_ok',
        waitedMs: Date.now() - start,
        status: net.status || null,
        bodyBytes: net.bodyBytes || null,
        bodySource: net.bodySource || null
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const net = creation && typeof creation.photoResult === 'function' ? creation.photoResult() : null;
  return {
    ok: false,
    reason: 'photo_process_timeout',
    waitedMs: Date.now() - start,
    status: net && net.status || null,
    bodyBytes: net && net.bodyBytes || null,
    bodySource: net && net.bodySource || null
  };
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
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'latin1');
  fs.writeFileSync(bodyFile, payload);
  const seconds = String(Math.min(180, Math.max(60, Math.ceil(payload.length / 40000) + 45)));
  const args = [
    '-sS', '-D', respHead, '-o', respBody, '-w', '%{http_code} %{size_upload} %{size_download}',
    '--max-time', seconds,
    '-x', `http://${HOST}:${PORT}`,
    '-U', `${authUser(baseUser, sessid)}:${password}`,
    '-X', method || 'POST',
    '-H', 'Expect:',
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
  return {
    status,
    body: resp,
    responseHeaders,
    up: meter.up,
    down: meter.down,
    exitCode: res.code,
    error: String(res.stderr || '').replace(/\s+/g, ' ').slice(0, 180)
  };
}

async function arm(page, baseUser, password, sessid, nome, meter) {
  const client = await page.target().createCDPSession();
  const note = meter && typeof meter === 'object' ? meter : {};
  const state = { proxied: 0, proxiedAtClick: null, publishCaptured: false, photo: null, bytesUp: 0, bytesDown: 0, held: [], inflight: 0, closed: false, client };
  state.notePhoto = (row) => {
    if (!row) return;
    const prev = state.photo;
    if (prev && prev.ok === false && prev.carriesFile === true) return;
    if (row.ok === true && row.carriesFile !== true) return;
    if (prev && prev.ok === true && prev.carriesFile === true && row.ok !== false) return;
    state.photo = row;
  };
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
    let best = Buffer.alloc(0);
    const take = (buf) => {
      if (buf && buf.length > best.length) best = buf;
    };
    const entries = Array.isArray(req.postDataEntries) ? req.postDataEntries : [];
    if (entries.length) {
      const chunks = [];
      for (const entry of entries) {
        if (entry && entry.bytes) chunks.push(Buffer.from(String(entry.bytes), 'base64'));
      }
      if (chunks.length) {
        const buf = Buffer.concat(chunks);
        buf._source = 'base64';
        take(buf);
      }
    }
    if (req.hasPostData && best.length < 20000) {
      try {
        const extra = await client.send('Fetch.getRequestPostData', { requestId: ev.requestId });
        if (extra && extra.postData) {
          const buf = extra.base64Encoded
            ? Buffer.from(String(extra.postData), 'base64')
            : Buffer.from(String(extra.postData), 'latin1');
          buf._source = extra.base64Encoded ? 'base64' : 'latin1';
          take(buf);
        }
      } catch {}
      if (req.postData) {
        const buf = Buffer.from(String(req.postData), 'latin1');
        buf._source = 'latin1';
        take(buf);
      }
    }
    return best;
  }
  async function onPaused(ev) {
    const req = ev.request || {};
    const bodyBuf = await readPausedBody(ev);
    const bodySource = bodyBuf._source || 'empty';
    const postData = bodyBuf.length > 120000
      ? bodyBuf.subarray(0, 120000).toString('latin1')
      : bodyBuf.toString('latin1');
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
        op: (operationName(postData) || operationName(headerText(req.headers)) || '').slice(0, 140),
        bodyBytes: bodyBuf.length,
        bodySource
      });
    } catch {}
    try {
      if (lane === 'proxy') {
        const urlSafe = safeUrl(req.url);
        const photoUrl = isPhotoUploadUrl(req.url);
        const contentType = headerValue(req.headers, 'content-type');
        let sendBuf = bodyBuf;
        let splice = '';
        let diskBytes = 0;
        if (photoUrl && !bodyHasImage(bodyBuf)) {
          const fileBuf = readPhotoFile(state.photoPath);
          diskBytes = fileBuf ? fileBuf.length : 0;
          const spliced = fileBuf ? splicePhotoFile(bodyBuf, contentType, fileBuf) : null;
          if (spliced) {
            sendBuf = spliced;
            sendBuf._source = 'disk';
            splice = 'spliced';
          } else {
            splice = fileBuf ? 'splice_failed' : (state.photoPath ? 'disk_not_image' : 'no_path');
          }
        }
        const carriesFile = photoUrl && photoCarriesFile(sendBuf);
        if (req.hasPostData && !sendBuf.length) {
          if (photoUrl) state.notePhoto({ ok: false, reason: 'photo_body_empty', bodyBytes: 0, bodySource, url: urlSafe, carriesFile: true });
          auditReplay(nome, { url: urlSafe, status: 0, bodyBytes: 0, bodySource, resourceType: ev.resourceType || '', reason: 'empty_body' });
          await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionFailed' });
          return;
        }
        if (photoUrl && state.photoPath && !bodyHasImage(sendBuf)) {
          state.notePhoto({ ok: false, reason: 'photo_body_not_image', bodyBytes: bodyBuf.length, bodySource, url: urlSafe, carriesFile: true });
          auditReplay(nome, {
            url: urlSafe,
            status: 0,
            bodyBytes: bodyBuf.length,
            bodySource,
            resourceType: ev.resourceType || '',
            reason: 'photo_body_not_image',
            splice,
            diskBytes,
            fields: multipartFieldNames(bodyBuf)
          });
          await client.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionFailed' });
          return;
        }
        const started = Date.now();
        const replay = await replayThroughProxy({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: sendBuf,
          baseUser,
          password,
          sessid
        });
        const replayRow = {
          url: urlSafe,
          status: replay.status || 0,
          exitCode: replay.exitCode,
          bodyBytes: sendBuf.length,
          capturedBytes: bodyBuf.length,
          bodySource: sendBuf._source || bodySource,
          splice,
          diskBytes,
          fields: photoUrl ? multipartFieldNames(bodyBuf) : '',
          up: replay.up,
          down: replay.down,
          ms: Date.now() - started,
          resourceType: ev.resourceType || '',
          note: responseNote(replay.body),
          curl: hideSecret(hideSecret(replay.error, password), baseUser).slice(0, 180)
        };
        if (photoUrl || bodyBuf.length >= 15000 || !replay.status || replay.status >= 400 || marked) auditReplay(nome, replayRow);
        if (photoUrl && (carriesFile || splice === 'spliced')) {
          const verdict = judgePhotoResponse(replay.status, replay.body);
          state.notePhoto(Object.assign({
            bodyBytes: sendBuf.length,
            bodySource: sendBuf._source || bodySource,
            status: replay.status || 0,
            url: urlSafe,
            carriesFile: true
          }, verdict));
        }
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
        if (marked && state.proxiedAtClick != null) {
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
    photoResult() {
      return gate && gate.photo ? gate.photo : null;
    },
    setUploadFile(filePath) {
      if (gate) gate.photoPath = String(filePath || '');
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

function upstreamFor(sessid) {
  const cfg = readSettings();
  return {
    host: HOST,
    port: PORT,
    user: authUser(cfg.user, sessid),
    pass: cfg.password
  };
}

module.exports = {
  classifyPublishRequest,
  isPublishMarked,
  acceptExit,
  operationName,
  readSettings,
  acquireExit,
  upstreamFor,
  isPhotoUploadUrl,
  bodyHasImage,
  photoCarriesFile,
  splicePhotoFile,
  multipartFieldNames,
  composerPhotoProblem,
  judgePhotoResponse,
  readComposerPhotoProblem,
  waitComposerPhoto,
  waitWifiPhotoUpload,
  MAX_ATTEMPTS,
  ASN,
  openForPublish,
  beginCreation,
  currentCreation,
  endCreation
};
