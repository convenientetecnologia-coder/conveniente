"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const glassSrc = fs.readFileSync(path.join(root, "scripts", "glassViewer.js"), "utf8");
const browserSrc = fs.readFileSync(path.join(root, "scripts", "browser.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const glass = require(path.join(root, "scripts", "glassViewer.js"));

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("OK", name);
  else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

check("tag_contrato", glassSrc.includes("2026-09-04_glass_human_only_v4"));
check("armed_helper", /function isGlassArmed\(page\)/.test(glassSrc));
check("ready_helper", /function isGlassReady\(page\)/.test(glassSrc));
check("painted_flag", glassSrc.includes("_ctGlassPainted"));
check("settled_flag", glassSrc.includes("_ctGlassSettled"));
check("enable_fn", /async function enableGlassForHuman\(page/.test(glassSrc));
check("disable_fn", /async function disableGlassForWork\(page/.test(glassSrc));
check("apply_unarmed_noop", glassSrc.includes("if (!isGlassArmed(page)) return readState(page);"));
check("nav_hook_armed_only", glassSrc.includes("function attachNavHookIfArmed(page)"));
check("nav_hook_detach", glassSrc.includes("function detachNavHook(page)"));
check("nav_hook_checks_armed", /const onNav = \(frame\) => \{[\s\S]{0,180}if \(!isGlassArmed\(page\)\) return;/.test(glassSrc));
check("queue_checks_armed", glassSrc.includes("if (queued && !pageClosed(page) && isGlassArmed(page))"));
check("runtime_no_hijack_without_state", glassSrc.includes("if (!window.__ctGlassViewerState) return;"));
check("disable_disarms_first", /async function disableGlassForWork[\s\S]{0,220}disarmGlass\(page\)/.test(glassSrc));
check("disable_relock_viewport", glassSrc.includes("async function relockViewportIdentity"));
check("disable_restore_window", glassSrc.includes("async function restoreWindowToWork"));
check("identity_snapshot", glassSrc.includes("function snapshotIdentityViewport"));
check("runtime_wipe_when_no_state", /if \(!st\) \{[\s\S]{0,220}html\.style\.transform = 'none'/.test(glassSrc));
check("scrub_idle", /async function scrubIdleGlassPaint/.test(glassSrc));
check("enable_snapshots_before_arm", /snapshotIdentityViewport\(page\);\s*armGlass\(page\)/.test(glassSrc));

check("patch_keeps_setviewport", /await page\.setViewport\(\{/.test(browserSrc));
check("boot_no_apply_glass", !browserSrc.includes("applyGlassViewer(firstMax"));
check("boot_bind_still_openbrowser_source", browserSrc.includes("source: 'openBrowser'"));
check("boot_no_max_glass_block", !/Operador: vidro maximizado/.test(browserSrc));
check("blindar_no_glass", !/async function _blindarOnce[\s\S]{0,700}applyGlassViewer/.test(browserSrc));
check("bring_no_maximize", !/async function bringWindowToFront[\s\S]{0,500}maximized/.test(browserSrc));
check("bring_no_apply_glass", !/async function bringWindowToFront[\s\S]{0,600}applyGlassViewer/.test(browserSrc));
check("invoke_uses_first_live", /async function invocarHumano[\s\S]{0,600}firstLivePage\(browser\)/.test(browserSrc));
check("invoke_enables_glass", browserSrc.includes("glassViewer.enableGlassForHuman(page, { source: 'invocarHumano' })"));
{
  const invStart = browserSrc.indexOf("async function invocarHumano");
  const selling = browserSrc.indexOf("SELLING_URL", invStart);
  const firstEnable = browserSrc.indexOf("enableGlassForHuman(page, { source: 'invocarHumano' }", invStart);
  check("invoke_glass_after_nav", invStart > 0 && selling > invStart && firstEnable > selling);
}
check("first_live_scans_pages", /async function firstLivePage[\s\S]{0,400}for \(const page of pages/.test(browserSrc));
check("first_live_skips_junk", browserSrc.includes("function pageUrlLooksJunk") && /async function firstLivePage[\s\S]{0,900}pageUrlLooksJunk/.test(browserSrc));
check("targetcreated_human_main", browserSrc.includes("source: 'targetcreated_human_main'"));
check("targetcreated_uses_first_live", /_ctGlassHumanArmed === true[\s\S]{0,280}firstLivePage\(browser\)/.test(browserSrc));
check("scrub_unarmed_always", /onlyIfArmed && !glassViewer\.isGlassArmed\(page\)[\s\S]{0,180}scrubIdleGlassPaint/.test(browserSrc) && !/onlyIfArmed && !glassViewer\.isGlassArmed\(page\)[\s\S]{0,180}_ctGlassRuntimeInstalled/.test(browserSrc));
check("browser_glass_flag", browserSrc.includes("_ctGlassHumanArmed"));
check("browser_exports_enable", browserSrc.includes("enableGlassForHumanBrowser"));
check("browser_exports_disable", browserSrc.includes("disableGlassForWorkBrowser"));

check("worker_resume_disables", workerSrc.includes("disableGlassForWorkBrowser(ctrl.browser, nome, { source: 'human_resume' })"));
check("worker_invoke_enables", workerSrc.includes("enableGlassForHumanBrowser(ctrl.browser, { source: 'invoke_human'"));
check("worker_enter_enables", workerSrc.includes("enableGlassForHumanBrowser(ctrl.browser, { source: 'enter_human_mode'"));
check("worker_only_if_ready", workerSrc.includes("onlyIfReady: true") && !workerSrc.includes("onlyIfDisarmed: true"));
{
  const enterAt = workerSrc.indexOf("async function enterHumanMode");
  const invAt = workerSrc.indexOf("invocarHumano", enterAt);
  const glassAt = workerSrc.indexOf("source: 'enter_human_mode'", enterAt);
  const ovAt = workerSrc.indexOf("ensureHumanOverlay(nome, ctrl, { reason })", enterAt);
  check("enter_overlay_after_glass", enterAt > 0 && invAt > enterAt && glassAt > invAt && ovAt > glassAt);
}
{
  const ff = workerSrc.indexOf("if (shouldInvoke) {");
  const ffEnter = workerSrc.indexOf("enterHumanMode(nome, controllers.get(nome), { reason: `fail_fast:", ff);
  const ffOv = workerSrc.indexOf("ensureHumanOverlay(nome, controllers.get(nome), { reason: `fail_fast:", ff);
  check("fail_fast_glass_before_overlay", ff > 0 && ffEnter > ff && ffOv > ffEnter);
}
check("fail_fast_uses_human_door", workerSrc.includes("await enterHumanMode(nome, controllers.get(nome), { reason: `fail_fast:"));
check("already_human_repairs_glass", workerSrc.includes("source: 'terminal_already_human'") && workerSrc.includes("source: 'nurse_already_human'"));
check("worker_start_work_disarm_if_armed", workerSrc.includes("source: 'start_work', onlyIfArmed: true"));
check("worker_robe_disarm_if_armed", workerSrc.includes("source: 'robe_cycle', onlyIfArmed: true"));
check("enter_human_skips_robe_queue", /async function enterHumanMode[\s\S]{0,220}robeQueue\.skip/.test(workerSrc));
check("invoke_skips_robe_queue", /async invoke_human[\s\S]{0,1400}robeQueue\.skip/.test(workerSrc));
{
  const at = workerSrc.indexOf("async function robeQueuedCycle");
  const slice = at >= 0 ? workerSrc.slice(at, at + 1600) : "";
  const humanAt = slice.indexOf("humanControl === true");
  const disableAt = slice.indexOf("disableGlassForWorkBrowser");
  check("robe_cycle_human_abort_before_disable", humanAt > 0 && disableAt > humanAt);
}
check("reconnect_human_remounts_glass", workerSrc.includes("source: 'cdp_reconnect_human'"));
check("reconnect_work_scrubs_glass", workerSrc.includes("source: 'cdp_reconnect_work'"));
check("reconnect_copies_glass_flag", workerSrc.includes("'_ctGlassHumanArmed'"));
check("overlay_resume_hits_handler", workerSrc.includes("await handlers['human-resume']({ nome })"));
check("disable_only_if_armed_opt", browserSrc.includes("onlyIfArmed") && browserSrc.includes("isGlassArmed(page)"));

check("fit_math_intact", Math.abs(glass.computeFitZoom(1920, 1080, 960, 540) - 0.5) < 1e-9);
check("letterbox_intact", glass.computeLetterbox(800, 600, 1000, 600, 1).offsetX > 0);
check("is_enabled_default", glass.isGlassViewerEnabled() === true);

function fakePage() {
  const page = {
    _onCount: 0,
    _cdp: 0,
    _vp: { width: 1366, height: 768, deviceScaleFactor: 1 },
    isClosed: () => false,
    on() { page._onCount += 1; },
    off() { page._off = true; },
    bringToFront: async () => { page._front = true; },
    opener: async () => null,
    browser: () => null,
    exposeFunction: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => ({
      innerW: 1366, innerH: 768, outerW: 1366, outerH: 768, vvW: 1366, vvH: 768
    }),
    viewport: () => page._vp,
    setViewport: async (vp) => { page._relock = vp; page._vp = Object.assign({}, page._vp, vp); },
    target() {
      page._cdp += 1;
      return {
        createCDPSession: async () => {
          page._cdp += 1;
          return {
            send: async (method) => {
              if (method === "Browser.getWindowForTarget") return { windowId: 1 };
              if (method === "Browser.getWindowBounds") {
                return { bounds: { windowState: "normal", width: 1366, height: 768, left: 10, top: 10 } };
              }
              if (method === "Page.getLayoutMetrics") {
                return { cssVisualViewport: { clientWidth: 1366, clientHeight: 768 } };
              }
              return {};
            },
            detach: async () => {}
          };
        }
      };
    }
  };
  return page;
}

(async () => {
  const cold = fakePage();
  check("unarmed_is_false", glass.isGlassArmed(cold) === false);
  const unarmed = await glass.applyGlassViewer(cold, { source: "openBrowser" });
  check("unarmed_apply_null_state", unarmed == null || unarmed.zoom === 1);
  check("unarmed_apply_no_cdp", cold._cdp === 0);
  check("unarmed_apply_no_nav_hook", cold._onCount === 0);
  check("unarmed_apply_no_front", cold._front !== true);

  const human = fakePage();
  await glass.enableGlassForHuman(human, { source: "invocarHumano" });
  check("human_armed", glass.isGlassArmed(human) === true);
  check("human_ready", glass.isGlassReady(human) === true);

  const half = fakePage();
  half._ctGlassHumanArmed = true;
  check("armed_without_paint_not_ready", glass.isGlassReady(half) === false);
  half._ctGlassPainted = true;
  check("armed_with_paint_ready", glass.isGlassReady(half) === true);
  const col = fakePage();
  col._ctGlassHumanArmed = true;
  col._ctGlassViewer = { disabled: false, collapsed: true };
  check("collapsed_counts_ready", glass.isGlassReady(col) === true);
  check("human_did_cdp", human._cdp > 0);
  check("human_nav_hook", human._onCount >= 1);
  check("human_brought_front", human._front === true);

  human._vp = { width: 9999, height: 9999, deviceScaleFactor: 2 };
  const afterWork = await glass.disableGlassForWork(human, { windowSize: { width: 800, height: 600 } });
  check("resume_disarmed", glass.isGlassArmed(human) === false);
  check("resume_detached_hook", human._off === true);
  check("resume_relock_preset_not_mutated", !!(human._relock && human._relock.width === 1366 && human._relock.height === 768));
  check("resume_ignores_foreign_window_size", human._relock && human._relock.width !== 800);
  check("resume_state_disabled", !!(afterWork && afterWork.disabled === true));
  check("identity_snap_kept", !!(human._ctGlassIdentityVp && human._ctGlassIdentityVp.width === 1366));

  const idle = fakePage();
  idle._ctGlassRuntimeInstalled = true;
  idle._evalClear = 0;
  idle.evaluate = async (fn) => {
    idle._evalClear += 1;
    if (typeof fn === "function") {
      try { fn(); } catch {}
    }
    return {};
  };
  await glass.scrubIdleGlassPaint(idle);
  check("scrub_idle_unarmed_runs", idle._evalClear >= 1);
  idle._ctGlassHumanArmed = true;
  idle._evalClear = 0;
  await glass.scrubIdleGlassPaint(idle);
  check("scrub_idle_armed_skips", idle._evalClear === 0);

  const again = fakePage();
  again._ctGlassHumanArmed = false;
  await glass.applyGlassViewer(again, { source: "framenavigated" });
  check("nav_without_arm_no_cdp", again._cdp === 0);

  if (fail) {
    console.log("RESULT FAIL", fail);
    process.exit(1);
  }
  console.log("RESULT OK");
})().catch((e) => {
  console.log("FAIL runtime", String((e && e.message) || e));
  process.exit(1);
});
