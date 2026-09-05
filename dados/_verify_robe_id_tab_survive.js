"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const hygieneSrc = fs.readFileSync(path.join(root, "scripts", "robeTabHygiene.js"), "utf8");
const idSrc = fs.readFileSync(path.join(root, "scripts", "robePostPublishId.js"), "utf8");
const browserSrc = fs.readFileSync(path.join(root, "scripts", "browser.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const hy = require(path.join(root, "scripts", "robeTabHygiene.js"));
const id = require(path.join(root, "scripts", "robePostPublishId.js"));

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("OK", name);
  else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

check("hygiene_exports_work_url", typeof hy.isRobeMarketplaceWorkUrl === "function");
check("create_still_create_only", hy.isCreateMarketplaceUrl("https://www.facebook.com/marketplace/you/selling") === false);
check("create_item_is_create", hy.isCreateMarketplaceUrl("https://www.facebook.com/marketplace/create/item") === true);
check("selling_is_work", hy.isRobeMarketplaceWorkUrl("https://www.facebook.com/marketplace/you/selling") === true);
check("create_is_work", hy.isRobeMarketplaceWorkUrl("https://www.facebook.com/marketplace/create/item") === true);
check("item_listing_is_work", hy.isRobeMarketplaceWorkUrl("https://www.facebook.com/marketplace/item/123") === true);
check("messages_not_work", hy.isRobeMarketplaceWorkUrl("https://www.facebook.com/messages") === false);

check("prune_keeps_work_url", /robeOn && isRobeMarketplaceWorkUrl\(u\)/.test(hygieneSrc));
check("header_says_selling_work", hygieneSrc.includes("you/selling apos publicar"));
check("one_tab_uses_work_url", browserSrc.includes("isRobeMarketplaceWorkUrl(u)"));
check("worker_import_work_url", workerSrc.includes("isRobeMarketplaceWorkUrl"));

check("id_handle_not_evaluate_death", /function pageHandleState\(page\)/.test(idSrc) && !/pageAlive[\s\S]{0,180}evaluate\(\(\) => true\)/.test(idSrc));
check("id_waits_redirect", idSrc.includes("waitForSellingRedirect"));
check("id_logs_handle", idSrc.includes("page_handle"));
check("selling_helper", id.isSellingUrl("https://www.facebook.com/marketplace/you/selling") === true);
check("closed_handle", id.pageHandleState({ isClosed: () => true }).ok === false);
check("open_handle", id.pageHandleState({ isClosed: () => false, url: () => "https://www.facebook.com/marketplace/you/selling" }).ok === true);

const robeSrc = fs.readFileSync(path.join(root, "scripts", "robe.js"), "utf8");
const veiSrc = fs.readFileSync(path.join(root, "scripts", "robeVeiculos.js"), "utf8");
const renewSrc = fs.readFileSync(path.join(root, "scripts", "robePostPublishRenew.js"), "utf8");
const planSrc = fs.readFileSync(path.join(root, "scripts", "marketplaceRenewPlan.js"), "utf8");
const shrinkSrc = fs.readFileSync(path.join(root, "scripts", "chromeWorkingSetShrink.js"), "utf8");

function seqOk(src) {
  const pub = src.indexOf("step: 'publish_ok'");
  const idCall = src.indexOf("robePostPublishId.runRobeAutoId");
  const renewCall = src.indexOf("robePostPublishRenew.runRobeAutoRenewSafe");
  const closeAfter = src.indexOf("await safeClosePage(page);", renewCall);
  return pub > 0 && idCall > pub && renewCall > idCall && closeAfter > renewCall;
}

check("item_seq_publish_id_renew_close", seqOk(robeSrc));
check("vehicle_seq_publish_id_renew_close", seqOk(veiSrc));
check("id_ignores_marketplaceRenew", !/marketplaceRenew/.test(idSrc));
check("renew_gate_own_enabled", planSrc.includes("config.enabled !== true || plan.enabled !== true"));
check("renew_skip_disabled", renewSrc.includes("shouldRun !== true"));

check("id_no_ews", !/emptyWorkingSet|shrinkRobeGate|shrinkRootPidAfterRobe/.test(idSrc));
check("renew_no_ews", !/emptyWorkingSet|shrinkRobeGate|shrinkRootPidAfterRobe/.test(renewSrc));
check("robe_item_no_ews", !/emptyWorkingSet|shrinkRobeGate|shrinkRootPidAfterRobe/.test(robeSrc));
check("robe_vehicle_no_ews", !/emptyWorkingSet|shrinkRobeGate|shrinkRootPidAfterRobe/.test(veiSrc));

const dyn = workerSrc.indexOf("res = await startRobeDynamic(");
const shrink1 = workerSrc.indexOf("await shrinkRootPidAfterRobe(nome, ctrl);", dyn);
const kick1 = workerSrc.indexOf("kickFaxinaAndMaybeResumeVirtus(nome, ctrl, {", shrink1);
check("worker_ews_after_startRobeDynamic", dyn > 0 && shrink1 > dyn && kick1 > shrink1);
check("shrink_log_after_tab1", shrinkSrc.includes("Aba 1 descartada"));
check("shrink_robe_only_in_worker_finally", (workerSrc.match(/await shrinkRootPidAfterRobe\(/g) || []).length === 4);

if (fail) {
  console.error("FAIL_COUNT", fail);
  process.exit(1);
}
console.log("ALL_OK_ROBE_ID_TAB_SURVIVE");
process.exit(0);
