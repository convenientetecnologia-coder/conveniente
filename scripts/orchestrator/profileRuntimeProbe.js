"use strict";

function safeBool(value) {
  return value === true;
}

function buildProfileRuntimeProbe({
  nome,
  ctrl,
  meta,
  health,
  desired,
  flags,
  autoMode,
  provisionLock
} = {}) {
  const d = desired && typeof desired === "object" ? desired : {};
  const m = meta && typeof meta === "object" ? meta : {};
  const h = health && typeof health === "object" ? health : {};
  const f = flags && typeof flags === "object" ? flags : {};
  const lock = provisionLock && typeof provisionLock === "object" ? provisionLock : {};
  return {
    schema: "ProfileRuntimeProbe.v1",
    profileId: String(nome || ""),
    desired: {
      active: safeBool(d.active),
      virtus: String(d.virtus || ""),
      humanHold: safeBool(d.humanHold)
    },
    runtime: {
      hasController: !!ctrl,
      hasBrowser: !!(ctrl && ctrl.browser),
      trabalhando: safeBool(ctrl && ctrl.trabalhando),
      configurando: safeBool(ctrl && ctrl.configurando),
      humanControl: safeBool(ctrl && ctrl.humanControl),
      virtusRunning: !!(ctrl && ctrl.virtus),
      sendLockActive: !!(ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active),
      robeRunning: safeBool(m.emExecucao),
      robeQueued: safeBool(m.emFila)
    },
    account: {
      loginRequired: safeBool(f.loginRequired),
      captchaCheckpoint: safeBool(f.captchaCheckpoint),
      identityRequired: safeBool(f.identityRequired),
      identitySubmitted: safeBool(f.identitySubmitted),
      appealSubmitted: safeBool(f.appealSubmitted),
      banned: safeBool(f.banned),
      twoFactor: safeBool(f.twoFactor)
    },
    flow: {
      reopenAt: Number(m.reopenAt || 0) || 0,
      activationHeldUntil: Number(m.activationHeldUntil || 0) || 0,
      killGuardUntil: Number(m.killGuardUntil || 0) || 0,
      openBackoffMs: Number(m.openBackoffMs || 0) || 0,
      closingReason: m.closingReason ? String(m.closingReason).slice(0, 160) : ""
    },
    health: {
      stage: String(h.stage || ""),
      cyclesWithoutLife: Number(h.counters && h.counters.cyclesWithoutLife || 0) || 0,
      lastOkAt: Number(h.lastOkAt || 0) || 0
    },
    resources: {
      autoMode: String(autoMode && autoMode.mode || ""),
      autoReason: String(autoMode && autoMode.reason || ""),
      provisionLockActive: safeBool(lock.active),
      provisionKind: String(lock.kind || "")
    }
  };
}

module.exports = {
  buildProfileRuntimeProbe
};
