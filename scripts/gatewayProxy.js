"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const manifestStore = require("./manifestStore");
const { readCtConfig } = require("./ctConfig");

const STATE_PATH = path.join(__dirname, "..", "dados", "gateway_proxy_state.json");
const HOSTID_PATH = path.join(__dirname, "..", "dados", ".telemetry_hostid");
const issueThrottleBySlot = new Map();

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) return fallback;
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeSlots(slots) {
  const arr = Array.isArray(slots) ? slots : [];
  const out = [];
  for (const s of arr) {
    const slotId = String(s && s.slotId || "").trim();
    const zone = String(s && s.zone || "").trim();
    const ip = String(s && s.ipCurrent || "").trim();
    if (!slotId || !zone || !ip) continue;
    out.push({
      slotId,
      zone,
      ipCurrent: ip,
      country: String(s && s.country || "").trim().toLowerCase() || null
    });
  }
  out.sort((a, b) => {
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
    if (a.ipCurrent !== b.ipCurrent) return a.ipCurrent.localeCompare(b.ipCurrent);
    return a.slotId.localeCompare(b.slotId);
  });
  return out;
}

function defaultState() {
  return {
    globalEnabled: false,
    hostEnabled: false,
    inventoryVersion: "",
    slots: [],
    superProxy: null,
    trafficAuthByZone: {},
    updatedAt: 0
  };
}

function readState() {
  const j = safeReadJson(STATE_PATH, defaultState()) || defaultState();
  j.globalEnabled = !!j.globalEnabled;
  j.hostEnabled = !!j.hostEnabled;
  j.inventoryVersion = String(j.inventoryVersion || "").trim();
  j.slots = normalizeSlots(j.slots);
  j.superProxy = j.superProxy && typeof j.superProxy === "object" ? j.superProxy : null;
  j.trafficAuthByZone = (j.trafficAuthByZone && typeof j.trafficAuthByZone === "object") ? j.trafficAuthByZone : {};
  j.updatedAt = Number(j.updatedAt || 0) || 0;
  return j;
}

function computeInventoryVersion(slots) {
  const payload = JSON.stringify(normalizeSlots(slots));
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function applyGatewayPayload(payload) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const next = defaultState();
  next.globalEnabled = !!p.globalEnabled;
  next.hostEnabled = !!p.hostEnabled;
  next.slots = normalizeSlots(p.slots);
  next.inventoryVersion = String(p.inventoryVersion || "").trim() || computeInventoryVersion(next.slots);
  next.superProxy = (p.superProxy && typeof p.superProxy === "object") ? {
    host: String(p.superProxy.host || "").trim(),
    port: Number(p.superProxy.port || 0) || 0,
    scheme: String(p.superProxy.scheme || "http").trim().toLowerCase() || "http"
  } : null;
  next.trafficAuthByZone = (p.trafficAuthByZone && typeof p.trafficAuthByZone === "object") ? p.trafficAuthByZone : {};
  next.updatedAt = Date.now();
  writeJsonAtomic(STATE_PATH, next);
  return { ok: true, slotsCount: next.slots.length, inventoryVersion: next.inventoryVersion };
}

function profileHash(profileName) {
  const s = String(profileName || "").trim();
  if (!s) return 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function resolveProxyForProfile({ profileName, manifest }) {
  const st = readState();
  if (!st.globalEnabled || !st.hostEnabled) return { enabled: false, reason: "gateway_disabled" };
  if (!st.superProxy || !st.superProxy.host || !st.superProxy.port) return { enabled: false, reason: "missing_superproxy" };
  const slots = st.slots || [];
  if (!slots.length) return { enabled: false, reason: "no_slots" };

  const byId = new Map(slots.map((s) => [s.slotId, s]));
  const currentSlotId = String(manifest && manifest.gatewayProxy && manifest.gatewayProxy.slotId || "").trim();
  let slot = currentSlotId ? (byId.get(currentSlotId) || null) : null;
  if (!slot) {
    const idx = profileHash(profileName) % slots.length;
    slot = slots[idx];
  }
  if (!slot) return { enabled: false, reason: "slot_unresolved" };

  const auth = st.trafficAuthByZone && st.trafficAuthByZone[slot.zone];
  const username = String(auth && auth.username || "").trim();
  const password = String(auth && auth.password || "").trim();
  if (!username || !password) return { enabled: false, reason: "missing_zone_auth", slot };

  const proxyServer = `${st.superProxy.scheme || "http"}://${st.superProxy.host}:${st.superProxy.port}`;
  const userWithIp = `${username}-ip-${slot.ipCurrent}`;
  return {
    enabled: true,
    slot,
    proxyServer,
    auth: { username: userWithIp, password },
    inventoryVersion: st.inventoryVersion || ""
  };
}

async function persistManifestAssignment(profileName, resolved) {
  if (!resolved || !resolved.enabled || !resolved.slot) return;
  const slot = resolved.slot;
  await manifestStore.update(profileName, (cur) => {
    const next = Object.assign({}, cur || {});
    next.gatewayProxy = Object.assign({}, next.gatewayProxy || {}, {
      slotId: String(slot.slotId || ""),
      zone: String(slot.zone || ""),
      ipCurrent: String(slot.ipCurrent || ""),
      inventoryVersion: String(resolved.inventoryVersion || ""),
      updatedAt: Date.now()
    });
    return next;
  });
}

function getNeedsFlags() {
  const st = readState();
  const needsGatewayInventory = !Array.isArray(st.slots) || st.slots.length === 0;
  let needsGatewayProxyTrafficCreds = true;
  try {
    needsGatewayProxyTrafficCreds = !(st.trafficAuthByZone && Object.keys(st.trafficAuthByZone).length > 0);
  } catch {
    needsGatewayProxyTrafficCreds = true;
  }
  return {
    needsGatewayInventory,
    needsGatewayProxyTrafficCreds
  };
}

function readHostIdSafe() {
  try {
    if (!fs.existsSync(HOSTID_PATH)) return "";
    return String(fs.readFileSync(HOSTID_PATH, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function shouldThrottleIssue(slotId, minMs) {
  const id = String(slotId || "").trim();
  if (!id) return false;
  const now = Date.now();
  const last = Number(issueThrottleBySlot.get(id) || 0) || 0;
  if (last > 0 && (now - last) < minMs) return true;
  issueThrottleBySlot.set(id, now);
  return false;
}

async function reportProxyIssue({ resolved, reason, context } = {}) {
  try {
    const slot = resolved && resolved.slot ? resolved.slot : null;
    if (!slot || !slot.slotId || !slot.zone || !slot.ipCurrent) return { ok: false, skipped: true, reason: "missing_slot" };
    const minMs = Math.max(30 * 1000, Number(process.env.GATEWAY_PROXY_ISSUE_REPORT_MIN_MS || (2 * 60 * 1000)) || (2 * 60 * 1000));
    if (shouldThrottleIssue(slot.slotId, minMs)) return { ok: false, skipped: true, reason: "throttled" };

    const cfg = readCtConfig();
    const ctBaseUrl = String(cfg && cfg.ctBaseUrl || "").trim().replace(/\/+$/, "");
    const secret = String(cfg && cfg.logIngestSecret || "").trim();
    if (!ctBaseUrl || !secret) return { ok: false, skipped: true, reason: "missing_ct_config" };

    const hostId = readHostIdSafe();
    if (!hostId) return { ok: false, skipped: true, reason: "missing_host_id" };
    const body = {
      hostId,
      slotId: String(slot.slotId),
      zone: String(slot.zone),
      ipCurrent: String(slot.ipCurrent),
      inventoryVersion: String(resolved.inventoryVersion || ""),
      reason: String(reason || "proxy_issue").slice(0, 220),
      context: context && typeof context === "object" ? context : null,
      sentAt: Date.now()
    };
    const resp = await fetch(`${ctBaseUrl}/api/gateway/proxy_issue_secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-log-secret": secret
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) return { ok: false, skipped: false, reason: `http_${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: false, reason: (e && e.message) ? String(e.message) : String(e) };
  }
}

module.exports = {
  readState,
  applyGatewayPayload,
  resolveProxyForProfile,
  persistManifestAssignment,
  getNeedsFlags,
  reportProxyIssue
};

