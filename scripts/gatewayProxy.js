"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const manifestStore = require("./manifestStore");
const { readCtConfig, resolveCtApiBase } = require("./ctConfig");

const STATE_PATH = path.join(__dirname, "..", "dados", "gateway_proxy_state.json");
const HOSTID_PATH = path.join(__dirname, "..", "dados", ".telemetry_hostid");
const PERFIS_PATH = path.join(__dirname, "..", "dados", "perfis.json");
const issueThrottleBySlot = new Map();
const ASSIGNMENT_PLANNER_VERSION = "v2_unique_first";
const COUNTRY_GEO_ANCHORS = {
  // Ancora por pais (derivado do proxy) para quando slot.geo ainda nao vier no payload.
  // Nao usa cidade da conta.
  br: { latitude: -15.7801, longitude: -47.9292, accuracy: 450000 }
};

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
    const proxy = (s && s.proxy && typeof s.proxy === "object") ? s.proxy : null;
    const row = {
      slotId,
      zone,
      ipCurrent: ip,
      country: String(s && s.country || "").trim().toLowerCase() || null
    };
    const geo = (s && s.geo && typeof s.geo === "object") ? s.geo : null;
    if (geo) {
      const latitude = Number(geo.latitude);
      const longitude = Number(geo.longitude);
      const accuracy = Number(geo.accuracy || 0) || 0;
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        row.geo = {
          latitude,
          longitude,
          accuracy: accuracy > 0 ? accuracy : 3000
        };
      }
    }
    if (proxy) {
      const host = String(proxy.host || "").trim();
      const port = Number(proxy.port || 0) || 0;
      const scheme = String(proxy.scheme || "http").trim().toLowerCase() || "http";
      const username = String(proxy.username || "").trim();
      const password = String(proxy.password || "").trim();
      if (host && port > 0 && username && password) {
        row.proxy = { scheme, host, port, username, password };
      }
    }
    out.push(row);
  }
  // Ordem canônica por slotId (id lógico estável), para reduzir reshuffle
  // quando apenas o IP do slot muda.
  out.sort((a, b) => a.slotId.localeCompare(b.slotId));
  return out;
}

function normalizeCoordsLike(input) {
  if (!input || typeof input !== "object") return null;
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracyRaw = Number(input.accuracy || 0) || 0;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: accuracyRaw > 0 ? accuracyRaw : 3000
  };
}

function resolveGeoFromSlot(slot) {
  const slotGeo = normalizeCoordsLike(slot && slot.geo);
  if (slotGeo) return { ok: true, coords: slotGeo, source: "slot_geo" };
  const country = String(slot && slot.country || "").trim().toLowerCase();
  const anchor = normalizeCoordsLike(COUNTRY_GEO_ANCHORS[country]);
  if (anchor) return { ok: true, coords: anchor, source: `slot_country_anchor:${country}` };
  return { ok: false, reason: "missing_slot_geo" };
}

function defaultState() {
  return {
    provider: "proxycheap",
    globalEnabled: false,
    hostEnabled: false,
    inventoryVersion: "",
    slots: [],
    superProxy: null,
    trafficAuthByZone: {},
    assignments: {},
    plannerVersion: "",
    updatedAt: 0
  };
}

function normalizeAssignments(input, slotsById) {
  const src = (input && typeof input === "object") ? input : {};
  const out = {};
  for (const [profileNameRaw, rec] of Object.entries(src)) {
    const profileName = String(profileNameRaw || "").trim();
    if (!profileName) continue;
    const slotId = String(rec && rec.slotId || "").trim();
    const inventoryVersion = String(rec && rec.inventoryVersion || "").trim();
    if (!slotId || !inventoryVersion) continue;
    if (!slotsById.has(slotId)) continue;
    const cohortIdRaw = String(rec && rec.cohortId || "").trim();
    const cohortId = /^[a-z0-9_:-]{1,64}$/i.test(cohortIdRaw) ? cohortIdRaw : "";
    out[profileName] = {
      slotId,
      inventoryVersion,
      cohortId,
      updatedAt: Number(rec && rec.updatedAt || 0) || 0
    };
  }
  return out;
}

function readPerfisRows() {
  const arr = safeReadJson(PERFIS_PATH, []);
  return Array.isArray(arr) ? arr : [];
}

function listKnownProfileNames() {
  const rows = readPerfisRows();
  const out = [];
  for (const r of rows) {
    const nome = String(r && r.nome || "").trim();
    if (!nome) continue;
    out.push(nome);
  }
  return out;
}

function listActiveProfileNames() {
  const rows = readPerfisRows();
  const out = [];
  for (const r of rows) {
    const nome = String(r && r.nome || "").trim();
    if (!nome) continue;
    if (r && r.active === true) out.push(nome);
  }
  return out;
}

function readManifestGatewayProxy(profileName) {
  try {
    const manPath = manifestStore.getManifestPath(profileName);
    const man = safeReadJson(manPath, {}) || {};
    const gp = (man && man.gatewayProxy && typeof man.gatewayProxy === "object") ? man.gatewayProxy : null;
    if (!gp) return null;
    const slotId = String(gp.slotId || "").trim();
    const inventoryVersion = String(gp.inventoryVersion || "").trim();
    if (!slotId || !inventoryVersion) return null;
    return { slotId, inventoryVersion };
  } catch {
    return null;
  }
}

function buildSlotProfileMap(activeAssignments) {
  const m = new Map();
  for (const [profileName, slotId] of Object.entries(activeAssignments || {})) {
    if (!m.has(slotId)) m.set(slotId, []);
    m.get(slotId).push(profileName);
  }
  return m;
}

function firstFreeSlotId(slotIds, activeAssignments) {
  const used = new Set(Object.values(activeAssignments || {}));
  for (const sid of slotIds) {
    if (!used.has(sid)) return sid;
  }
  return "";
}

function chooseLeastLoadedSlot(slotIds, activeAssignments, profileName) {
  const counts = new Map();
  for (const sid of slotIds) counts.set(sid, 0);
  for (const sid of Object.values(activeAssignments || {})) {
    if (counts.has(sid)) counts.set(sid, (counts.get(sid) || 0) + 1);
  }
  let min = Infinity;
  let candidates = [];
  for (const sid of slotIds) {
    const c = counts.get(sid) || 0;
    if (c < min) {
      min = c;
      candidates = [sid];
    } else if (c === min) {
      candidates.push(sid);
    }
  }
  if (!candidates.length) return slotIds[0] || "";
  const idx = profileHash(profileName) % candidates.length;
  return candidates[idx];
}

function orderedSlotIdsForHost(slotIds) {
  const ids = Array.isArray(slotIds) ? slotIds.slice() : [];
  if (ids.length <= 1) return ids;
  let hostId = "";
  try { hostId = readHostIdSafe(); } catch {}
  hostId = String(hostId || "").trim();
  if (!hostId) return ids;
  const offset = profileHash(hostId) % ids.length;
  if (!offset) return ids;
  return ids.slice(offset).concat(ids.slice(0, offset));
}

function buildTargetLoadBySlot(slotIds, totalAssigned) {
  const ids = Array.isArray(slotIds) ? slotIds.slice() : [];
  const total = Math.max(0, Number(totalAssigned || 0) || 0);
  const n = ids.length;
  const out = new Map();
  if (n <= 0) return out;
  const base = Math.floor(total / n);
  const rem = total % n;
  for (let i = 0; i < ids.length; i++) {
    out.set(ids[i], base + (i < rem ? 1 : 0));
  }
  return out;
}

function rebalanceAssignmentsToTargets(slotIds, assignments) {
  const ids = Array.isArray(slotIds) ? slotIds.slice() : [];
  const src = (assignments && typeof assignments === "object") ? assignments : {};
  if (!ids.length) return Object.assign({}, src);
  const out = Object.assign({}, src);
  const counts = new Map(ids.map((sid) => [sid, 0]));
  for (const sid of Object.values(out)) {
    if (!counts.has(sid)) continue;
    counts.set(sid, (counts.get(sid) || 0) + 1);
  }
  const target = buildTargetLoadBySlot(ids, Object.keys(out).length);
  const bySlot = () => buildSlotProfileMap(out);
  const maxMoves = Math.max(0, Object.keys(out).length * 2);
  let moves = 0;
  while (moves < maxMoves) {
    let sourceSid = "";
    let sourceExcess = 0;
    for (const sid of ids) {
      const excess = (counts.get(sid) || 0) - (target.get(sid) || 0);
      if (excess > sourceExcess) {
        sourceExcess = excess;
        sourceSid = sid;
      }
    }
    let destSid = "";
    let destLack = 0;
    for (const sid of ids) {
      const lack = (target.get(sid) || 0) - (counts.get(sid) || 0);
      if (lack > destLack) {
        destLack = lack;
        destSid = sid;
      }
    }
    if (!sourceSid || !destSid || sourceExcess <= 0 || destLack <= 0 || sourceSid === destSid) break;
    const holders = (bySlot().get(sourceSid) || []).slice();
    if (!holders.length) break;
    // Determinístico: move primeiro quem "menos combina" com o slot atual.
    holders.sort((a, b) => profileHash(b) - profileHash(a) || b.localeCompare(a));
    const chosen = holders[0];
    out[chosen] = destSid;
    counts.set(sourceSid, Math.max(0, (counts.get(sourceSid) || 0) - 1));
    counts.set(destSid, (counts.get(destSid) || 0) + 1);
    moves += 1;
  }
  return out;
}

function reconcileAssignments(nextState, prevState) {
  const slots = Array.isArray(nextState && nextState.slots) ? nextState.slots : [];
  const slotIds = slots.map((s) => String(s && s.slotId || "").trim()).filter(Boolean);
  const slotIdsHost = orderedSlotIdsForHost(slotIds);
  const slotsById = new Map(slots.map((s) => [s.slotId, s]));
  const inv = String(nextState && nextState.inventoryVersion || "").trim();
  const now = Date.now();

  const prevAssignments = normalizeAssignments(prevState && prevState.assignments, slotsById);
  const knownProfiles = new Set(listKnownProfileNames());
  const activeProfiles = Array.from(knownProfiles);

  const keptAssignments = {};
  for (const [profileName, rec] of Object.entries(prevAssignments)) {
    if (!knownProfiles.has(profileName)) continue;
    if (rec.inventoryVersion !== inv) continue;
    keptAssignments[profileName] = { slotId: rec.slotId, inventoryVersion: inv, updatedAt: rec.updatedAt || now };
  }

  // Manifest sticky é fonte de verdade por perfil (quando válido para inventário atual).
  for (const profileName of knownProfiles) {
    const gp = readManifestGatewayProxy(profileName);
    if (!gp) continue;
    if (gp.inventoryVersion !== inv) continue;
    if (!slotsById.has(gp.slotId)) continue;
    keptAssignments[profileName] = { slotId: gp.slotId, inventoryVersion: inv, updatedAt: now };
  }

  const activeAssignments = {};
  for (const profileName of activeProfiles) {
    const rec = keptAssignments[profileName];
    if (!rec || !slotsById.has(rec.slotId)) continue;
    activeAssignments[profileName] = rec.slotId;
  }

  // Unique-first: se há slot livre, desmonta colisões mantendo 1 dono por slot.
  if (slotIdsHost.length > 0) {
    const bySlot = buildSlotProfileMap(activeAssignments);
    for (const sid of slotIdsHost) {
      const holders = (bySlot.get(sid) || []).slice();
      if (holders.length <= 1) continue;
      holders.sort((a, b) => profileHash(a) - profileHash(b) || a.localeCompare(b));
      const keep = holders[0];
      for (let i = 1; i < holders.length; i++) {
        const p = holders[i];
        const freeSid = firstFreeSlotId(slotIdsHost, activeAssignments);
        if (!freeSid) break;
        if (freeSid === activeAssignments[keep]) continue;
        activeAssignments[p] = freeSid;
      }
    }
  }

  // Perfis ativos sem slot: usa slots livres primeiro, depois menor carga.
  for (const profileName of activeProfiles) {
    if (activeAssignments[profileName]) continue;
    let sid = firstFreeSlotId(slotIdsHost, activeAssignments);
    if (!sid) sid = chooseLeastLoadedSlot(slotIdsHost, activeAssignments, profileName);
    if (!sid) continue;
    activeAssignments[profileName] = sid;
  }

  // Balanceamento final: garante distribuição aproximada ideal (diferença <= 1 entre slots),
  // mantendo decisão determinística para evitar oscilação entre ciclos.
  const balancedAssignments = rebalanceAssignmentsToTargets(slotIdsHost, activeAssignments);

  const out = Object.assign({}, keptAssignments);
  for (const [profileName, sid] of Object.entries(balancedAssignments)) {
    if (!sid || !slotsById.has(sid)) continue;
    out[profileName] = { slotId: sid, inventoryVersion: inv, updatedAt: now };
  }
  return out;
}

function readState() {
  const j = safeReadJson(STATE_PATH, defaultState()) || defaultState();
  j.provider = String(j.provider || "proxycheap").trim().toLowerCase() || "proxycheap";
  j.globalEnabled = !!j.globalEnabled;
  j.hostEnabled = !!j.hostEnabled;
  j.inventoryVersion = String(j.inventoryVersion || "").trim();
  j.slots = normalizeSlots(j.slots);
  const slotsById = new Map(j.slots.map((s) => [s.slotId, s]));
  j.superProxy = j.superProxy && typeof j.superProxy === "object" ? j.superProxy : null;
  j.trafficAuthByZone = (j.trafficAuthByZone && typeof j.trafficAuthByZone === "object") ? j.trafficAuthByZone : {};
  j.assignments = normalizeAssignments(j.assignments, slotsById);
  j.plannerVersion = String(j.plannerVersion || "").trim();
  j.updatedAt = Number(j.updatedAt || 0) || 0;
  return j;
}

function computeInventoryVersion(slots) {
  const payload = JSON.stringify(normalizeSlots(slots));
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function applyGatewayPayload(payload) {
  const prev = readState();
  const p = (payload && typeof payload === "object") ? payload : {};
  const next = defaultState();
  next.provider = String(p.provider || prev.provider || "proxycheap").trim().toLowerCase() || "proxycheap";
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
  const slotsById = new Map((Array.isArray(next.slots) ? next.slots : []).map((s) => [String(s && s.slotId || "").trim(), s]));
  // CT é o maestro: mantém assignments existentes e aplica plano vindo do CT.
  // Não redistribui localmente no host.
  next.assignments = normalizeAssignments(prev && prev.assignments, slotsById);
  // Plano vindo do CT (controle global): quando presente, prevalece por perfil.
  try {
    const plannedRaw = (p.assignments && typeof p.assignments === "object") ? p.assignments : {};
    const cohortRaw = (p.cohortAssignments && typeof p.cohortAssignments === "object") ? p.cohortAssignments : {};
    const normalizedPlan = {};
    for (const [profileNameRaw, recRaw] of Object.entries(plannedRaw)) {
      const profileName = String(profileNameRaw || "").trim();
      if (!profileName) continue;
      const rec = (recRaw && typeof recRaw === "object") ? recRaw : {};
      const slotId = String(rec.slotId || "").trim();
      if (!slotId || !slotsById.has(slotId)) continue;
      const cohortIdRaw = String(rec.cohortId || "").trim();
      const cohortId = /^[a-z0-9_:-]{1,64}$/i.test(cohortIdRaw) ? cohortIdRaw : "";
      normalizedPlan[profileName] = {
        slotId,
        inventoryVersion: String(next.inventoryVersion || ""),
        cohortId,
        updatedAt: Date.now()
      };
    }
    for (const [profileNameRaw, recRaw] of Object.entries(cohortRaw)) {
      const profileName = String(profileNameRaw || "").trim();
      if (!profileName) continue;
      const rec = (recRaw && typeof recRaw === "object") ? recRaw : {};
      const cohortIdRaw = String(rec.cohortId || "").trim();
      const cohortId = /^[a-z0-9_:-]{1,64}$/i.test(cohortIdRaw) ? cohortIdRaw : "";
      if (!cohortId) continue;
      if (!normalizedPlan[profileName]) {
        const prevRec = next.assignments && next.assignments[profileName] ? next.assignments[profileName] : null;
        if (!prevRec) continue;
        normalizedPlan[profileName] = {
          slotId: String(prevRec.slotId || "").trim(),
          inventoryVersion: String(next.inventoryVersion || ""),
          cohortId,
          updatedAt: Date.now()
        };
        continue;
      }
      normalizedPlan[profileName].cohortId = cohortId;
    }
    if (Object.keys(normalizedPlan).length > 0) {
      next.assignments = Object.assign({}, next.assignments || {}, normalizedPlan);
    }
  } catch {}
  next.plannerVersion = ASSIGNMENT_PLANNER_VERSION;
  next.updatedAt = Date.now();
  writeJsonAtomic(STATE_PATH, next);
  try { require("./connectLane").syncFromGatewayState(); } catch {}
  return { ok: true, slotsCount: next.slots.length, inventoryVersion: next.inventoryVersion };
}

function resolveCohortForProfile({ profileName, manifest }) {
  const st = readState();
  if (!st.globalEnabled || !st.hostEnabled) return { enabled: false, reason: "gateway_disabled" };
  const inv = String(st.inventoryVersion || "");
  const assigned = (st.assignments && st.assignments[profileName]) ? st.assignments[profileName] : null;
  if (!assigned || String(assigned.inventoryVersion || "") !== inv) {
    return { enabled: false, reason: "missing_slot_assignment" };
  }
  const cohortId = String(assigned.cohortId || "").trim();
  if (!cohortId) return { enabled: false, reason: "missing_cohort_assignment" };
  return { enabled: true, cohortId };
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

function ensureLocalAssignmentForProfile({ profileName, state, slotsById }) {
  const nome = String(profileName || "").trim();
  if (!nome) return null;
  const st = (state && typeof state === "object") ? state : readState();
  const byId = (slotsById instanceof Map) ? slotsById : new Map((Array.isArray(st.slots) ? st.slots : []).map((s) => [String(s && s.slotId || "").trim(), s]));
  const inv = String(st.inventoryVersion || "").trim();
  if (!inv || byId.size <= 0) return null;

  const current = (st.assignments && st.assignments[nome]) ? st.assignments[nome] : null;
  if (current && String(current.inventoryVersion || "") === inv && byId.has(String(current.slotId || "").trim())) {
    return current;
  }

  const activeAssignments = {};
  for (const [pnameRaw, recRaw] of Object.entries(st.assignments || {})) {
    const pname = String(pnameRaw || "").trim();
    if (!pname) continue;
    const rec = (recRaw && typeof recRaw === "object") ? recRaw : {};
    const sid = String(rec.slotId || "").trim();
    if (!sid || !byId.has(sid)) continue;
    if (String(rec.inventoryVersion || "") !== inv) continue;
    activeAssignments[pname] = sid;
  }

  const orderedSlotIds = orderedSlotIdsForHost(Array.from(byId.keys()));
  let pickedSlotId = "";
  // Preferência: manter slot antigo do próprio perfil quando ainda disponível.
  const legacySlotId = String(current && current.slotId || "").trim();
  if (legacySlotId && byId.has(legacySlotId)) {
    pickedSlotId = legacySlotId;
  }
  if (!pickedSlotId) pickedSlotId = firstFreeSlotId(orderedSlotIds, activeAssignments);
  if (!pickedSlotId) pickedSlotId = chooseLeastLoadedSlot(orderedSlotIds, activeAssignments, nome);
  if (!pickedSlotId || !byId.has(pickedSlotId)) return null;

  const now = Date.now();
  const nextAssignments = Object.assign({}, st.assignments || {}, {
    [nome]: {
      slotId: pickedSlotId,
      inventoryVersion: inv,
      cohortId: String(current && current.cohortId || "").trim(),
      updatedAt: now
    }
  });
  const nextState = Object.assign({}, st, { assignments: nextAssignments, updatedAt: now });
  try { writeJsonAtomic(STATE_PATH, nextState); } catch {}
  return nextAssignments[nome] || null;
}

function resolveProxyForProfile({ profileName, manifest }) {
  const st = readState();
  if (!st.globalEnabled || !st.hostEnabled) return { enabled: false, reason: "gateway_disabled" };
  // Qualquer provedor com credencial no slot (ASocks, ProxyCheap, etc.).
  // O CT decide o provider; este host só aplica o comando gateway_set_proxies.
  const provider = String(st.provider || "").trim().toLowerCase();
  const slots = st.slots || [];
  if (!slots.length) return { enabled: false, reason: "no_slots" };

  const byId = new Map(slots.map((s) => [s.slotId, s]));
  const inv = String(st.inventoryVersion || "");
  let assigned = (st.assignments && st.assignments[profileName]) ? st.assignments[profileName] : null;
  let slot = null;
  if (assigned && assigned.inventoryVersion === inv && byId.has(assigned.slotId)) {
    slot = byId.get(assigned.slotId);
  }
  if (!assigned || String(assigned.inventoryVersion || "") !== inv || !slot) {
    const recovered = ensureLocalAssignmentForProfile({ profileName, state: st, slotsById: byId });
    if (recovered) {
      assigned = recovered;
      if (String(assigned.inventoryVersion || "") === inv && byId.has(assigned.slotId)) {
        slot = byId.get(assigned.slotId);
      }
    }
  }
  if (!assigned || String(assigned.inventoryVersion || "") !== inv) return { enabled: false, reason: "missing_slot_assignment" };
  if (!slot) return { enabled: false, reason: "assigned_slot_unavailable" };

  let proxyServer = "";
  let auth = null;
  const slotProxy = (slot && slot.proxy && typeof slot.proxy === "object") ? slot.proxy : null;
  if (!slotProxy || !slotProxy.host || !slotProxy.port) return { enabled: false, reason: "missing_slot_proxy", slot };
  proxyServer = `${slotProxy.scheme || "http"}://${slotProxy.host}:${slotProxy.port}`;
  auth = {
    username: String(slotProxy.username || "").trim(),
    password: String(slotProxy.password || "").trim()
  };
  if (!auth || !auth.username || !auth.password) return { enabled: false, reason: "missing_slot_auth", slot };
  return {
    enabled: true,
    slot,
    provider,
    proxyServer,
    auth,
    inventoryVersion: st.inventoryVersion || ""
  };
}

function resolveGeoForProfile({ profileName, manifest }) {
  const resolved = resolveProxyForProfile({ profileName, manifest });
  if (!resolved || resolved.enabled !== true) {
    return {
      enabled: false,
      reason: String(resolved && resolved.reason || "geo_proxy_unresolved").trim() || "geo_proxy_unresolved"
    };
  }
  const slot = resolved.slot || null;
  if (!slot) return { enabled: false, reason: "missing_slot_assignment" };
  const geo = resolveGeoFromSlot(slot);
  if (!geo.ok || !geo.coords) {
    return {
      enabled: false,
      reason: String(geo.reason || "missing_slot_geo"),
      slotId: String(slot.slotId || ""),
      zone: String(slot.zone || ""),
      ipCurrent: String(slot.ipCurrent || "")
    };
  }
  return {
    enabled: true,
    coords: geo.coords,
    source: String(geo.source || "slot_geo"),
    slotId: String(slot.slotId || ""),
    zone: String(slot.zone || ""),
    ipCurrent: String(slot.ipCurrent || ""),
    provider: String(resolved.provider || ""),
    inventoryVersion: String(resolved.inventoryVersion || "")
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
    const hasSlotCreds = Array.isArray(st.slots) && st.slots.length > 0 && st.slots.every((s) => {
      const p = s && s.proxy && typeof s.proxy === "object" ? s.proxy : null;
      return !!(p && p.host && p.port && p.username && p.password);
    });
    needsGatewayProxyTrafficCreds = !hasSlotCreds;
  } catch {
    needsGatewayProxyTrafficCreds = true;
  }
  return {
    needsGatewayInventory,
    needsGatewayProxyTrafficCreds
  };
}

function getRuntimeSummary() {
  const st = readState();
  const zones = Array.isArray(st.slots) ? Array.from(new Set(st.slots.map((s) => String(s.zone || "").trim()).filter(Boolean))) : [];
  const provider = String(st.provider || "proxycheap").trim().toLowerCase();
  const inv = String(st.inventoryVersion || "");
  const byId = new Map((Array.isArray(st.slots) ? st.slots : []).map((s) => [String(s && s.slotId || "").trim(), s]));
  let hasTrafficCreds = true;
  try {
    const hasSlotCreds = Array.isArray(st.slots) && st.slots.length > 0 && st.slots.every((s) => {
      const p = s && s.proxy && typeof s.proxy === "object" ? s.proxy : null;
      return !!(p && p.host && p.port && p.username && p.password);
    });
    hasTrafficCreds = hasSlotCreds;
  } catch {
    hasTrafficCreds = false;
  }
  const slotUsageBySlot = {};
  let assignedActiveCount = 0;
  const parts = [];
  try {
    for (const [profileName, rec] of Object.entries(st.assignments || {})) {
      if (String(rec && rec.inventoryVersion || "") !== inv) continue;
      const sid = String(rec && rec.slotId || "").trim();
      if (!sid || !byId.has(sid)) continue;
      slotUsageBySlot[sid] = (Number(slotUsageBySlot[sid] || 0) || 0) + 1;
      assignedActiveCount += 1;
      const p = String(profileName || "").trim();
      if (p) parts.push(`${p}:${sid}`);
    }
  } catch {}
  parts.sort((a, b) => a.localeCompare(b));
  const assignmentSignature = parts.join("|");
  return {
    provider,
    globalEnabled: !!st.globalEnabled,
    hostEnabled: !!st.hostEnabled,
    inventoryVersion: String(st.inventoryVersion || ""),
    slotsCount: Array.isArray(st.slots) ? st.slots.length : 0,
    zonesCount: zones.length,
    hasTrafficCreds: !!hasTrafficCreds,
    assignedActiveCount,
    assignmentSignature,
    slotUsageBySlot,
    updatedAt: Number(st.updatedAt || 0) || 0
  };
}

function isStrictProxyRequired() {
  const st = readState();
  return !!(st && st.globalEnabled === true && st.hostEnabled === true);
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

function probeSlotConnect(resolved, { destHost = "www.facebook.com", destPort = 443, timeoutMs = 8000 } = {}) {
  const slotProxy = resolved && resolved.slot && resolved.slot.proxy && typeof resolved.slot.proxy === "object"
    ? resolved.slot.proxy
    : null;
  const proxyHost = String(slotProxy && slotProxy.host || "").trim();
  const proxyPort = Number(slotProxy && slotProxy.port || 0) || 0;
  const user = String(slotProxy && slotProxy.username || "").trim();
  const pass = String(slotProxy && slotProxy.password || "").trim();
  if (!proxyHost || proxyPort <= 0 || !user || !pass) {
    return Promise.resolve({ ok: false, skipped: true, detail: "missing_proxy_creds" });
  }
  const net = require("net");
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: proxyHost, port: proxyPort, timeout: timeoutMs });
    let buf = "";
    const done = (ok, detail) => {
      try { s.destroy(); } catch {}
      resolve({ ok: !!ok, ms: Date.now() - t0, detail: String(detail || "").slice(0, 120) });
    };
    s.on("timeout", () => done(false, "timeout"));
    s.on("error", (e) => done(false, (e && e.code) || e.message));
    s.on("connect", () => {
      const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
      s.write(
        `CONNECT ${destHost}:${destPort} HTTP/1.1\r\n` +
        `Host: ${destHost}:${destPort}\r\n` +
        `Proxy-Authorization: Basic ${token}\r\n` +
        `Proxy-Connection: Keep-Alive\r\n\r\n`
      );
    });
    s.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.indexOf("\r\n\r\n") >= 0) {
        const first = buf.split(/\r\n/)[0] || "";
        done(/HTTP\/1\.[01] 200/i.test(first), first);
      }
    });
  });
}

async function reportProxyIssue({ resolved, reason, context } = {}) {
  try {
    const slot = resolved && resolved.slot ? resolved.slot : null;
    if (!slot || !slot.slotId || !slot.zone || !slot.ipCurrent) return { ok: false, skipped: true, reason: "missing_slot" };
    const minMs = Math.max(30 * 1000, Number(process.env.GATEWAY_PROXY_ISSUE_REPORT_MIN_MS || (2 * 60 * 1000)) || (2 * 60 * 1000));
    if (shouldThrottleIssue(slot.slotId, minMs)) return { ok: false, skipped: true, reason: "throttled" };

    const cfg = readCtConfig();
    const ctBaseUrl = resolveCtApiBase((cfg && cfg.ctBaseUrl) || process.env.CT_BASE_URL || process.env.CT_URL || "");
    const secret = String(cfg && cfg.logIngestSecret || "").trim();
    if (!ctBaseUrl) return { ok: false, skipped: true, reason: "missing_ct_config" };

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
        ...(secret ? { "x-log-secret": secret } : {})
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) return { ok: false, skipped: false, reason: `http_${resp.status}` };
    try {
      if (/tunnel/i.test(String(reason || ""))) {
        require("./connectLane").noteFailure(String(reason || "").slice(0, 160));
      }
    } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: false, reason: (e && e.message) ? String(e.message) : String(e) };
  }
}

module.exports = {
  readState,
  applyGatewayPayload,
  resolveProxyForProfile,
  resolveCohortForProfile,
  resolveGeoForProfile,
  persistManifestAssignment,
  isStrictProxyRequired,
  getNeedsFlags,
  getRuntimeSummary,
  reportProxyIssue
};

