'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const names = 'HELLO OPEN DATA END PING PONG OPEN_OK OPEN_ERR ACTIVATE ACTIVATE_ACK HEARTBEAT HEARTBEAT_ACK RELEASE RELEASE_ACK REVOKE CANCEL STATUS STATUS_ACK PHASE ERROR WINDOW TAKEOVER TAKEOVER_ACK TAKEOVER_COMMIT'.split(' ');
const F = Object.freeze(Object.fromEntries(names.map((name, i) => [name, i + 1])));
const schemas = new Map();
class ProtocolError extends Error { constructor(code = 'protocol_error') { super(code); this.code = code; } }
const fail = code => { throw new ProtocolError(code); };

// JSON.parse sozinho aceita propriedades duplicadas e perde sua evidência.
function strictJSON(text) {
  let i = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') { try { return JSON.parse(text.slice(start, i)); } catch { fail(); } }
    }
    fail();
  }
  function value(depth = 0) {
    if (depth > 64) fail();
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space(); const keys = new Set(), out = Object.create(null);
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        if (text[i] !== '"') fail();
        const key = string(); if (keys.has(key)) fail(); keys.add(key); space();
        if (text[i++] !== ':') fail(); out[key] = value(depth + 1); space();
        const end = text[i++]; if (end === '}') return out; if (end !== ',') fail(); space();
      }
    }
    if (text[i] === '[') {
      i++; space(); const out = []; if (text[i] === ']') { i++; return out; }
      for (;;) { out.push(value(depth + 1)); space(); const end = text[i++]; if (end === ']') return out; if (end !== ',') fail(); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) fail(); i += match[0].length;
    const result = JSON.parse(match[0]); if (typeof result === 'number' && !Number.isFinite(result)) fail(); return result;
  }
  const result = value(); space(); if (i !== text.length) fail(); return result;
}
function schema(name) {
  if (!schemas.has(name)) schemas.set(name, JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', name + '.json'), 'utf8')));
  return schemas.get(name);
}
function validate(value, spec, depth = 0) {
  if (depth > 64) fail();
  if (spec.oneOf) {
    let successes = 0;
    for (const option of spec.oneOf) { try { validate(value, option, depth + 1); successes++; } catch (e) { if (!(e instanceof ProtocolError)) throw e; } }
    if (successes !== 1) fail(); return value;
  }
  switch (spec.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
      for (const key of spec.required || []) if (!Object.hasOwn(value, key)) fail();
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.properties || {}, key)) { if (spec.additionalProperties === false) fail(); }
        else validate(value[key], spec.properties[key], depth + 1);
      }
      break;
    case 'string': {
      if (typeof value !== 'string') fail();
      const length = Array.from(value).length;
      if (length < (spec.minLength || 0) || length > (spec.maxLength ?? 65536)) fail();
      if (spec.pattern && !(new RegExp('^(?:' + spec.pattern + ')$')).test(value)) fail();
      if (spec.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail();
      break;
    }
    case 'integer': if (!Number.isSafeInteger(value)) fail(); // falls through
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value) || value < (spec.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (spec.maximum ?? Number.MAX_SAFE_INTEGER)) fail(); break;
    case 'boolean': if (typeof value !== 'boolean') fail(); break;
    case 'array': if (!Array.isArray(value) || value.length > (spec.maxItems ?? 64)) fail(); for (const item of value) validate(item, spec.items, depth + 1); break;
    default: fail();
  }
  if (Object.hasOwn(spec, 'const') && value !== spec.const) fail();
  if (spec.enum && !spec.enum.includes(value)) fail();
  return value;
}
const quote = s => JSON.stringify(s).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function canonical(value) {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail(); return String(value); }
  if (typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const compare = (a, b) => { const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0)); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
    return '{' + Object.keys(value).sort(compare).map(k => quote(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  fail();
}
function validateBody(kind, body) {
  if (!Number.isInteger(kind) || kind < 1 || kind > names.length) fail();
  if (kind === F.DATA) { if (!Buffer.isBuffer(body) || body.length > 32768) fail(); }
  else validate(body, schema(names[kind - 1].toLowerCase()));
  return body;
}
function encode(kind, id, body) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) fail(); validateBody(kind, body);
  // ACKs podem conter segundos fracionários; assinatura canônica só para grants.
  const payload = kind === F.DATA ? body : Buffer.from(JSON.stringify(body));
  if (payload.length + 9 > 65536) fail();
  const head = Buffer.alloc(9); head.write('CP2\0'); head[4] = kind; head.writeUInt32BE(id, 5); return Buffer.concat([head, payload]);
}
function decode(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 9 || raw.length > 65536 || !raw.subarray(0, 4).equals(Buffer.from('CP2\0'))) fail();
  const kind = raw[4], id = raw.readUInt32BE(5); let body;
  if (kind === F.DATA) body = raw.subarray(9);
  else { let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(9)); } catch { fail(); } body = strictJSON(text); }
  validateBody(kind, body); return { kind, id, body };
}
function signGrant(claims, key) {
  validate(claims, schema('grant'));
  if (!Buffer.isBuffer(key) || key.length < 32 || !(claims.issuedAt < claims.expiresAt && claims.expiresAt <= claims.absoluteDeadline)) fail('unauthorized');
  const payload = Buffer.from(canonical(claims), 'ascii').toString('base64url');
  const token = payload + '.' + crypto.createHmac('sha256', key).update(payload, 'ascii').digest('base64url');
  if (token.length > 8192) fail(); return token;
}
function verifyGrant(token, keyring, now = Date.now() / 1000) {
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^[\w-]+\.[\w-]+$/.test(token)) fail();
    const [payload, signature] = token.split('.'), raw = Buffer.from(payload, 'base64url'), sig = Buffer.from(signature, 'base64url');
    if (raw.toString('base64url') !== payload || sig.toString('base64url') !== signature) fail();
    const claims = strictJSON(new TextDecoder('utf-8', { fatal: true }).decode(raw)); validate(claims, schema('grant'));
    const key = keyring[claims.keyId]; if (!Buffer.isBuffer(key) || key.length < 32) fail();
    const expected = crypto.createHmac('sha256', key).update(payload, 'ascii').digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected) || canonical(claims) !== raw.toString('ascii') || !Number.isFinite(now) || now < claims.issuedAt || !(claims.issuedAt < claims.expiresAt && claims.expiresAt <= claims.absoluteDeadline)) fail();
    if (now >= claims.expiresAt) fail('lease_expired'); return claims;
  } catch (e) { if (e.code === 'lease_expired') throw e; fail('unauthorized'); }
}
const contextKeys = ['protocolVersion','contractRevision','instanceId','resourceId','executorFence','authorityEpoch','carrierGeneration'];
const identityKeys = ['protocolVersion','carrierGeneration','operationId','leaseId','leaseGeneration','serverId'];
function identity(value) { return Object.fromEntries(identityKeys.map(k => [k, value[k]])); }
function sameIdentity(a, b) { return identityKeys.every(k => a[k] === b[k]); }
function context(value) { return Object.fromEntries(contextKeys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]])); }
module.exports = { F, ProtocolError, strictJSON, schema, validate, validateBody, canonical, encode, decode, signGrant, verifyGrant, identity, sameIdentity, context, contextKeys };
