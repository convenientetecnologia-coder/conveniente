"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const hygieneSrc = fs.readFileSync(path.join(root, "scripts", "robeTabHygiene.js"), "utf8");
const browserSrc = fs.readFileSync(path.join(root, "scripts", "browser.js"), "utf8");
const hy = require(path.join(root, "scripts", "robeTabHygiene.js"));

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("OK", name);
  else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

function fakePage(url, extra) {
  return Object.assign(
    {
      url() {
        return url;
      }
    },
    extra || {}
  );
}

function freshBrowser(extra) {
  return Object.assign(
    {
      _pageBirth: {},
      _robeActiveFor: null,
      _convenienteGateInFlight: 0,
      _suppressBlankKillUntil: {}
    },
    extra || {}
  );
}

check("header_says_newborn_not_junk", hygieneSrc.includes("Blank nascendo != lixo"));
check("settle_const_exported", Number(hy.PAGE_SETTLE_MS) >= 15000 && Number(hy.PAGE_SETTLE_MS) <= 90000);
check("pagesLookAllJunk_takes_ctx", /function pagesLookAllJunk\(pages,\s*ctx\)/.test(hygieneSrc));
check("cure_skips_gate", hygieneSrc.includes('action: "gate_busy"'));
check("cure_skips_newborn", hygieneSrc.includes('"settle_newborn"'));
check("cure_skips_robe_nav", hygieneSrc.includes('action: "robe_hold"'));
check("cure_detached_wait", hygieneSrc.includes('action: "nav_detached_wait"'));
check("detached_not_protocol_sick", !hy.isChromeProtocolSickError("Navigating frame was detached"));
check("detached_helper", hy.isNavDetachedError("Navigating frame was detached") === true);
check("crash_still_sick", hy.isChromeProtocolSickError("Page crashed") === true);

const b = freshBrowser();
const blank = fakePage("about:blank");
check("newborn_blank_not_all_junk", hy.pagesLookAllJunk([blank], { browser: b, nome: "camacari" }) === false);
check("newborn_kind", hy.classifyTabKind(blank, { browser: b, nome: "camacari" }) === "newborn");

const dead = fakePage("chrome-error://chromewebdata/");
check("dead_is_all_junk", hy.pagesLookAllJunk([dead], { browser: b, nome: "camacari" }) === true);
check("dead_kind", hy.classifyTabKind(dead, { browser: b, nome: "camacari" }) === "dead");

const live = fakePage("https://www.facebook.com/messages");
check("live_plus_newborn_not_junk", hy.pagesLookAllJunk([live, blank], { browser: b, nome: "camacari" }) === false);

const zombie = fakePage("about:blank");
zombie.__convenienteBirth = Date.now() - 60_000;
const zb = freshBrowser();
check("zombie_blank_is_junk", hy.pagesLookAllJunk([zombie], { browser: zb, nome: "bauru" }) === true);
check("zombie_kind", hy.classifyTabKind(zombie, { browser: zb, nome: "bauru" }) === "zombie_blank");

const robeBrowser = freshBrowser({ _robeActiveFor: "bauru" });
const robeBlank = fakePage("about:blank");
robeBlank.__convenienteBirth = Date.now() - 60_000;
check("robe_hold_old_blank_is_newborn", hy.isNewbornBlank(robeBlank, { browser: robeBrowser, nome: "bauru" }) === true);
check("robe_hold_not_all_junk", hy.pagesLookAllJunk([robeBlank], { browser: robeBrowser, nome: "bauru" }) === false);

check("empty_pages_still_junk", hy.pagesLookAllJunk([], { browser: b, nome: "x" }) === true);

check("nurse_passes_tab_ctx", /pagesLookAllJunk\(pages,\s*tabCtx\)/.test(workerSrc));
check("nurse_skips_opening", /if \(opening\[nome\]\) continue;[\s\S]{0,180}tabCtx/.test(workerSrc));
check("nurse_clears_strikes_on_settle", /settle_newborn\|gate_busy\|robe_hold\|nav_detached_wait/.test(workerSrc));
check("periodic_passes_tab_ctx", /pagesLookAllJunk\(pages,\s*tabCtx\)/.test(workerSrc));
check("periodic_skips_robe_cure", /if \(!inRobe && !gateBusy\) \{\s*await tryCureAccountBrowser\(nome, \{ source: 'periodic_junk_only' \}\)/.test(workerSrc));
check("cure_restore_throttle_on_skip", /if \(result && result\.skipped\) \{\s*robeMeta\[n\]\.lastChromeCureAt = last;/.test(workerSrc));
check("blank_killer_waits_settle", browserSrc.includes("blank nascendo espera") && /age < settleMs/.test(browserSrc));
check("blank_killer_still_kills_zombie", browserSrc.includes("about_blank_killed"));
check("pruner_still_caps_extra", /function closeExtraPages/.test(workerSrc) && workerSrc.includes("inRobe"));
check("auto_robe_untouched", workerSrc.includes("function robeEnqueueAuto"));
check("ws_shrink_untouched", workerSrc.includes("function auditWsShrink"));
check("selling_is_robe_work", hy.isRobeMarketplaceWorkUrl("https://www.facebook.com/marketplace/you/selling") === true);
check("prune_keeps_selling_work", hygieneSrc.includes("isRobeMarketplaceWorkUrl"));

if (fail) {
  console.error("FAIL_COUNT", fail);
  process.exit(1);
}
console.log("ALL_OK_TAB_HYGIENE_SETTLE_CONTRACT");
process.exit(0);
