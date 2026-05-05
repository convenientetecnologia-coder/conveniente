"use strict";

function classifyPressure(probe) {
  const p = probe && typeof probe === "object" ? probe : {};
  const rt = p.runtime || {};
  const account = p.account || {};
  const flow = p.flow || {};
  const reasons = [];

  if (account.banned) reasons.push("account_banned");
  if (account.twoFactor) reasons.push("account_two_factor");
  if (account.loginRequired) reasons.push("login_required");
  if (account.captchaCheckpoint) reasons.push("captcha_checkpoint");
  if (account.identityRequired || account.identitySubmitted) reasons.push("identity_flow");
  if (account.appealSubmitted) reasons.push("appeal_monitor");
  if (rt.humanControl) reasons.push("human_control");
  if (rt.configurando) reasons.push("configuring");
  if (rt.robeRunning) reasons.push("robe_running");
  if (rt.sendLockActive) reasons.push("send_lock_active");
  if (Number(flow.killGuardUntil || 0) > Date.now()) reasons.push("kill_guard");

  return {
    mode: reasons.length ? "blocked_or_busy" : "eligible",
    reasons
  };
}

function decideShadow(probe) {
  const pressure = classifyPressure(probe);
  return {
    schema: "ShadowDecision.v1",
    profileId: probe && probe.profileId ? String(probe.profileId) : "",
    mode: pressure.mode,
    reasons: pressure.reasons,
    recommendedAction: pressure.mode === "eligible" ? "observe_only" : "hold_observe_only",
    enforce: false
  };
}

module.exports = {
  classifyPressure,
  decideShadow
};
