"use strict";

/**
 * Contrato único: navegador saudável aberto tem que estar trabalhando.
 *
 * Ativos  = Chrome vivo.
 * Trabalhando = motor (Virtus) ligado.
 * Problema real (login/captcha/ban/2FA/identidade/hold) = não trabalha.
 * Qualquer outro Chrome aberto + desired.active = liga o motor.
 *
 * Não abre navegador. Não fecha navegador. Não mexe no nurse.
 */

const HARD_FLAG_REASONS = [
  ["banned", "banned"],
  ["twoFactor", "two_factor"],
  ["marketplaceDisabled", "marketplace_disabled"],
  ["captchaCheckpoint", "captcha_checkpoint"],
  ["idVirtus", "id_virtus"],
  ["loginRequired", "login_required"],
  ["identitySubmitted", "identity_submitted"],
  ["identityRequired", "identity_required"],
  ["appealSubmitted", "appeal_submitted"],
  ["messengerPin", "messenger_pin"]
];

function hardBlockReason(flags) {
  const f = flags && typeof flags === "object" ? flags : {};
  for (const [key, reason] of HARD_FLAG_REASONS) {
    if (f[key] === true) return reason;
  }
  return null;
}

function classifyEnsureWorking(input = {}) {
  if (input.openAllActive === true) return { action: "skip", reason: "open_all_in_flight" };
  if (input.provisionBlocked === true) return { action: "skip", reason: "provision_lock" };
  if (input.wantActive !== true) return { action: "skip", reason: "desired_inactive" };
  if (input.wantHumanHold === true) return { action: "skip", reason: "human_hold" };
  if (input.humanControl === true) return { action: "skip", reason: "human_control" };
  if (input.configurando === true) return { action: "skip", reason: "configurando" };
  if (input.robeBusy === true) return { action: "skip", reason: "robe_busy" };
  if (input.faxinaHold === true) return { action: "skip", reason: "faxina_hold" };
  if (input.frozen === true) return { action: "skip", reason: "frozen" };
  if (input.browserConnected !== true) return { action: "skip", reason: "no_browser" };

  const hard = hardBlockReason(input.flags);
  if (hard) return { action: "skip", reason: hard };

  if (input.trabalhando === true && input.virtusOnline === true) {
    return { action: "skip", reason: "already_working" };
  }

  const virtusOff = String(input.wantVirtus || "").trim().toLowerCase() === "off";
  if (virtusOff) return { action: "arm_and_start", reason: "healthy_active_virtus_off" };
  if (input.trabalhando === true && input.virtusOnline !== true) {
    return { action: "start", reason: "trabalhando_without_virtus" };
  }
  return { action: "start", reason: "healthy_idle" };
}

function isEnsureWorkingEnabled() {
  return String(process.env.ENSURE_WORKING_TICK || "1").trim() !== "0";
}

function createEnsureWorkingTick(deps) {
  const {
    getControllers,
    readDesired,
    readAccountFlags,
    startWork,
    armVirtusOn,
    isOpenAllActive,
    isProvisionBlocked,
    isFrozen,
    isRobeBusy,
    isFaxinaHold,
    inShard,
    audit,
    nowMs
  } = deps;

  let running = false;
  const lastFailAt = new Map();
  const FAIL_BACKOFF_MS = Math.max(
    15_000,
    Math.min(180_000, Number(process.env.ENSURE_WORKING_FAIL_BACKOFF_MS || 45_000) || 45_000)
  );
  const MAX_START = Math.max(
    1,
    Math.min(20, Number(process.env.ENSURE_WORKING_MAX_START_PER_TICK || 6) || 6)
  );

  async function tick() {
    if (!isEnsureWorkingEnabled()) return { ok: true, skipped: true, reason: "disabled" };
    if (running) return { ok: true, skipped: true, reason: "already_running" };
    running = true;
    const now = typeof nowMs === "function" ? nowMs() : Date.now();
    const summary = {
      ts: now,
      event: "ensure_working_tick",
      scanned: 0,
      started: 0,
      armed: 0,
      skipped: 0,
      errors: 0,
      startedNames: [],
      skippedBag: {},
      errorNames: []
    };
    try {
      const openAllActive = !!(isOpenAllActive && isOpenAllActive());
      const provisionBlocked = !!(isProvisionBlocked && isProvisionBlocked());
      const desired = (readDesired && readDesired()) || { perfis: {} };
      const dmap = desired.perfis && typeof desired.perfis === "object" ? desired.perfis : {};
      const controllers = getControllers && getControllers();
      const names = controllers && typeof controllers.keys === "function"
        ? Array.from(controllers.keys())
        : [];

      for (const nome of names) {
        if (inShard && !inShard(nome)) continue;
        const ctrl = controllers.get ? controllers.get(nome) : null;
        const want = dmap[nome] || {};
        const browserConnected = !!(ctrl && ctrl.browser && (
          typeof ctrl.browser.isConnected === "function" ? ctrl.browser.isConnected() : true
        ));
        let flags = {};
        try { flags = (readAccountFlags && await readAccountFlags(nome)) || {}; } catch { flags = {}; }

        const decision = classifyEnsureWorking({
          openAllActive,
          provisionBlocked,
          wantActive: want.active === true,
          wantVirtus: want.virtus,
          wantHumanHold: want.humanHold === true,
          browserConnected,
          trabalhando: !!(ctrl && ctrl.trabalhando),
          virtusOnline: !!(ctrl && ctrl.virtus),
          humanControl: !!(ctrl && ctrl.humanControl),
          configurando: !!(ctrl && ctrl.configurando),
          robeBusy: !!(isRobeBusy && isRobeBusy(nome)),
          faxinaHold: !!(isFaxinaHold && isFaxinaHold(nome)),
          frozen: !!(isFrozen && isFrozen(nome)),
          flags
        });
        summary.scanned += 1;

        if (decision.action === "skip") {
          summary.skipped += 1;
          summary.skippedBag[decision.reason] = (summary.skippedBag[decision.reason] || 0) + 1;
          continue;
        }

        const lastFail = Number(lastFailAt.get(nome) || 0) || 0;
        if (lastFail && (now - lastFail) < FAIL_BACKOFF_MS) {
          summary.skipped += 1;
          summary.skippedBag.fail_backoff = (summary.skippedBag.fail_backoff || 0) + 1;
          continue;
        }
        if (summary.started >= MAX_START) {
          summary.skipped += 1;
          summary.skippedBag.tick_cap = (summary.skippedBag.tick_cap || 0) + 1;
          continue;
        }

        if (decision.action === "arm_and_start") {
          try {
            if (armVirtusOn) await armVirtusOn(nome);
            summary.armed += 1;
          } catch (e) {
            lastFailAt.set(nome, now);
            summary.errors += 1;
            if (summary.errorNames.length < 12) {
              summary.errorNames.push({
                nome: String(nome),
                reason: "arm_failed",
                error: String((e && e.message) || e).slice(0, 120)
              });
            }
            continue;
          }
        }

        const r = await startWork({
          nome,
          operator: `ensure_working:${decision.reason}`
        }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));

        if (r && r.ok) {
          lastFailAt.delete(nome);
          summary.started += 1;
          if (summary.startedNames.length < 20) summary.startedNames.push(String(nome));
        } else {
          lastFailAt.set(nome, now);
          summary.errors += 1;
          if (summary.errorNames.length < 12) {
            summary.errorNames.push({
              nome: String(nome),
              reason: decision.reason,
              error: String((r && r.error) || "start_work_failed").slice(0, 120)
            });
          }
        }
      }

      if (audit && (summary.started || summary.errors || summary.armed)) {
        try { audit(summary); } catch {}
      }
      return { ok: true, ...summary };
    } finally {
      running = false;
    }
  }

  return { tick, classifyEnsureWorking };
}

module.exports = {
  HARD_FLAG_REASONS,
  hardBlockReason,
  classifyEnsureWorking,
  isEnsureWorkingEnabled,
  createEnsureWorkingTick
};
