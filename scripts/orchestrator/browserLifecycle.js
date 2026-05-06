"use strict";

function createBrowserLifecycle(deps = {}) {
  const {
    puppeteer,
    logger,
    orchAudit,
    issues,
    provisionAudit,
    robeQueue,
    controllers,
    robeMeta,
    healthState,
    getProfileFailures,
    stopPruneLoop,
    cleanupProfileTransientLocks,
    reportAction,
    snapshotStatusAndWrite,
    getAvailableMB,
    registerFailure,
    isFrozenNow,
    readJsonFile,
    desiredPath,
    getControlledReopenDelayMs,
    setKillGuard,
    disconnectedKillGuardMs,
    isPidAlive,
    killProcessTreeByRootPid,
    browserHelper,
    manifestStore,
    loadPerfisJson,
    resolveChromeUserDataRoot,
    wirePageObservers,
    maybeStartPruneLoop,
    sleep,
    newFlowId,
    freezeCooldownIfNotWorking,
    cdpReconnectCfg,
    browserCloseTimeoutMs = 15_000
  } = deps;

  async function hardCloseController(nome, ctrl, { reason = "", allowKillUserDataDir = true } = {}) {
    const t0 = Date.now();
    const flowId = newFlowId("hard_close");
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: "worker_hard_close_begin",
        nome: String(nome || ""),
        reason: String(reason || ""),
        flowId,
        freeMB: getAvailableMB(),
        allowKillUserDataDir: !!allowKillUserDataDir
      });
    } catch {}
    let rootPid = (robeMeta[nome] && robeMeta[nome].rootPid) || null;
    try {
      if (!rootPid && ctrl && ctrl.browser && typeof ctrl.browser.process === "function") {
        const proc = ctrl.browser.process();
        if (proc && proc.pid) rootPid = proc.pid;
      }
    } catch {}
    let userDataDir = null;
    try {
      const man = await manifestStore.read(nome).catch(() => null);
      if (man && man.userDataDir) userDataDir = String(man.userDataDir);
    } catch {}
    if (!userDataDir) {
      try {
        const perfisArr = loadPerfisJson();
        const perfil = Array.isArray(perfisArr) ? perfisArr.find((p) => p && p.nome === nome) : null;
        if (perfil && perfil.userDataDir) userDataDir = String(perfil.userDataDir);
      } catch {}
    }
    if (!userDataDir) {
      try {
        userDataDir = resolveChromeUserDataRoot()
          ? require("path").join(resolveChromeUserDataRoot(), "Conveniente", String(nome || "").trim())
          : null;
      } catch {}
    }
    let closeOutcome = { ok: false, timeout: false, err: null };
    const rootPidAliveBefore = rootPid ? isPidAlive(rootPid) : null;
    const closePromise = (async () => {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === "function") {
          await ctrl.browser.close().catch(() => {});
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, err: error };
      }
    })();
    const raced = await Promise.race([
      closePromise,
      sleep(browserCloseTimeoutMs).then(() => ({ ok: false, timeout: true }))
    ]);
    closeOutcome = raced || closeOutcome;
    if (rootPid && (!closeOutcome.ok || closeOutcome.timeout || isPidAlive(rootPid))) {
      try { await killProcessTreeByRootPid(rootPid); } catch {}
    }
    if (allowKillUserDataDir && userDataDir) {
      try { browserHelper.killChromeProfileProcesses(userDataDir); } catch {}
    }
    const rootPidAliveAfter = rootPid ? isPidAlive(rootPid) : null;
    let udirPidsAfter = null;
    let udirPidsMetaOk = null;
    let udirPidsMetaErr = null;
    try {
      if (userDataDir && browserHelper.getChromeProfilePidsMeta) {
        const chk = browserHelper.getChromeProfilePidsMeta(userDataDir);
        udirPidsMetaOk = chk ? !!chk.ok : null;
        udirPidsMetaErr = chk && chk.error ? String(chk.error).slice(0, 180) : null;
        udirPidsAfter = chk && chk.pids ? chk.pids.slice(0, 24) : [];
      }
    } catch {}
    const durMs = Date.now() - t0;
    try {
      await issues.append(
        nome,
        "mil_action",
        `deactivate_hard reason=${reason} closeOk=${!!closeOutcome.ok} timeout=${!!closeOutcome.timeout} durMs=${durMs} rootPid=${rootPid || 0} userDataDir="${userDataDir || ""}"`
      );
    } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: "worker_hard_close_done",
        nome: String(nome || ""),
        reason: String(reason || ""),
        flowId,
        freeMB: getAvailableMB(),
        durMs,
        rootPid: rootPid || null,
        userDataDir: userDataDir || null,
        closeOutcome: {
          ok: !!closeOutcome.ok,
          timeout: !!closeOutcome.timeout,
          err: closeOutcome && closeOutcome.err ? String(closeOutcome.err && closeOutcome.err.message || closeOutcome.err).slice(0, 180) : null
        },
        rootPidAliveBefore,
        rootPidAliveAfter,
        udirPidsMetaOk,
        udirPidsMetaErr,
        udirPidsAfter
      });
    } catch {}
    return {
      ok: true,
      flowId,
      durMs,
      rootPid: rootPid || null,
      userDataDir: userDataDir || null,
      closeOutcome,
      rootPidAliveBefore,
      rootPidAliveAfter,
      udirPidsMetaOk,
      udirPidsMetaErr,
      udirPidsAfter
    };
  }

  async function tryReconnectAfterDisconnected(nome, prevCtrl) {
    const startedAt = Date.now();
    const flowId = newFlowId("reconnect");
    if (!cdpReconnectCfg.enabled) return { ok: false, reason: "disabled", flowId };
    const wsEndpoint = (
      (robeMeta[nome] && typeof robeMeta[nome].wsEndpoint === "string" && robeMeta[nome].wsEndpoint) ||
      (prevCtrl && prevCtrl.browser && typeof prevCtrl.browser.wsEndpoint === "function" ? String(prevCtrl.browser.wsEndpoint() || "") : "")
    );
    if (!wsEndpoint) return { ok: false, reason: "missing_ws_endpoint", flowId };

    const rootPid = (robeMeta[nome] && robeMeta[nome].rootPid) || null;
    if (rootPid && !isPidAlive(rootPid)) {
      return { ok: false, reason: "root_pid_not_alive", flowId, rootPid };
    }

    for (let attempt = 1; attempt <= cdpReconnectCfg.attempts; attempt++) {
      const delayMs = cdpReconnectCfg.delaysMs[Math.min(cdpReconnectCfg.delaysMs.length - 1, Math.max(0, attempt - 1))];
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: "reconnect_attempt",
          nome: String(nome || ""),
          flowId,
          attempt,
          wsPresent: true,
          rootPid: rootPid || null,
          pidAlive: rootPid ? isPidAlive(rootPid) : null
        });
      } catch {}
      try {
        const b = await puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: null,
          protocolTimeout: 60_000
        });
        if (b && b.isConnected && b.isConnected()) {
          const pages = await b.pages().catch(() => []);
          const current = controllers.get(nome);
          const nextCtrl = Object.assign({}, (current || prevCtrl || {}), { browser: b });
          controllers.set(nome, nextCtrl);
          try { attachBrowserLifecycle(nome, b); } catch {}
          try {
            if (pages && pages[0]) {
              nextCtrl.mainPage = pages[0];
              await wirePageObservers(nome, nextCtrl.mainPage).catch(() => {});
              maybeStartPruneLoop(nome, nextCtrl.browser, nextCtrl.mainPage);
            }
          } catch {}
          try { await snapshotStatusAndWrite(); } catch {}
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: "reconnect_success",
              nome: String(nome || ""),
              flowId,
              attempt,
              pagesCount: Array.isArray(pages) ? pages.length : null,
              durationMs: Date.now() - startedAt
            });
          } catch {}
          return { ok: true, flowId, attempt, pagesCount: Array.isArray(pages) ? pages.length : null };
        }
      } catch (error) {
        const msg = error && error.message ? String(error.message) : String(error);
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: "reconnect_fail",
            nome: String(nome || ""),
            flowId,
            attempt,
            error: msg.slice(0, 200),
            rootPid: rootPid || null,
            pidAliveAfter: rootPid ? isPidAlive(rootPid) : null
          });
        } catch {}
      }
      if (attempt < cdpReconnectCfg.attempts) await sleep(delayMs);
    }
    return { ok: false, reason: "exhausted", flowId, durationMs: Date.now() - startedAt };
  }

  async function handleBrowserDisconnected({ nome, browser } = {}) {
    try {
      logger.info("[WORKER][BROWSER] disconnected", { nome });
      orchAudit("runtime_signal_observed", {
        profileId: String(nome || ""),
        signalKind: "browser_disconnected",
        source: "attachBrowserLifecycle.disconnected"
      });
      try { robeQueue.skip && robeQueue.skip(nome); } catch {}

      const ctrl = controllers.get(nome);
      if (ctrl && ctrl.browser === browser) {
        try {
          const rc = await tryReconnectAfterDisconnected(nome, ctrl);
          if (rc && rc.ok) {
            try { issues.append(nome, "mil_action", `reconnect_success attempt=${Number(rc.attempt || 0)}`).catch(() => {}); } catch {}
            return;
          }
          try { issues.append(nome, "mil_action", `restart_fallback reason=${String((rc && rc.reason) || "unknown")}`).catch(() => {}); } catch {}
        } catch {}
      }
      if (ctrl) {
        ctrl.humanControl = false;
        ctrl.configurando = false;
      }
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: "browser_disconnected",
          nome: String(nome || ""),
          working: !!(ctrl && ctrl.trabalhando),
          humanControl: !!(ctrl && ctrl.humanControl),
          configurando: !!(ctrl && ctrl.configurando),
          emExecucao: !!(robeMeta[nome] && robeMeta[nome].emExecucao),
          freeMB: getAvailableMB()
        });
      } catch {}
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === "function") {
          await ctrl.virtus.stop().catch(() => {});
        }
      } catch {}

      try { freezeCooldownIfNotWorking(nome); } catch {}

      controllers.delete(nome);

      try {
        if (robeMeta[nome]) {
          robeMeta[nome].rootPid = null;
        }
      } catch {}

      try { healthState.delete(nome); } catch {}
      try {
        const profileFailures = getProfileFailures ? getProfileFailures() : null;
        if (profileFailures && typeof profileFailures.delete === "function") profileFailures.delete(nome);
      } catch {}
      try {
        if (robeMeta[nome]) {
          delete robeMeta[nome].emExecucao;
          delete robeMeta[nome].emFila;
          delete robeMeta[nome].cpuHistory;
          delete robeMeta[nome].ramHist;
          delete robeMeta[nome].reloadAttemptsWindow;
          delete robeMeta[nome].blockDetectWindow;
        }
      } catch {}

      try { await reportAction(nome, "browser_disconnected", "Janela/navegador fechado (evento disconnected)"); } catch {}

      stopPruneLoop(nome);
      cleanupProfileTransientLocks(nome, "disconnected");

      try { await registerFailure(nome, "disconnected", "external"); } catch {}
      try {
        const d = readJsonFile(desiredPath, { perfis: {} });
        const isDesiredActive = d.perfis?.[nome]?.active === true;
        const isHold = d.perfis?.[nome]?.humanHold === true;
        robeMeta[nome] = robeMeta[nome] || {};
        const now = Date.now();

        if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
          if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
            const reopenDelayMs = getControlledReopenDelayMs("disconnected");
            robeMeta[nome].reopenAt = now + reopenDelayMs;
            robeMeta[nome].closingReason = "disconnected";
            issues.append(nome, "mil_action", `nurse_reopen_scheduled(disconnected) in ${Math.round(reopenDelayMs / 1000)}s`).catch(() => {});
            setKillGuard(nome, disconnectedKillGuardMs);
          } else {
            issues.append(nome, "mil_action", "reopen_preserved_existing(disconnected)").catch(() => {});
          }
        } else {
          robeMeta[nome].reopenAt = null;
          issues.append(
            nome,
            "mil_action",
            isFrozenNow(nome)
              ? "reopen_suppressed_frozen"
              : (isHold ? "reopen_suppressed_human_hold" : "reopen_suppressed_desired_off")
          ).catch(() => {});
        }
      } catch {}

      try { await snapshotStatusAndWrite(); } catch {}
    } catch (error) {
      try { logger.warn("[WORKER][BROWSER] disconnect handler err", { error: error && error.message || error }); } catch {}
    }
    try {
      browser.removeAllListeners && browser.removeAllListeners("targetcreated");
      browser.removeAllListeners && browser.removeAllListeners("targetchanged");
      browser.removeAllListeners && browser.removeAllListeners("targetdestroyed");
    } catch {}
  }

  function attachBrowserLifecycle(nome, browser) {
    browser.once("disconnected", async () => {
      await handleBrowserDisconnected({ nome, browser });
    });
  }

  return {
    attachBrowserLifecycle,
    handleBrowserDisconnected,
    hardCloseController,
    tryReconnectAfterDisconnected
  };
}

module.exports = {
  createBrowserLifecycle
};
