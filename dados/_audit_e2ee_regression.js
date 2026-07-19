/**
 * Auditoria estática do contrato E2EE/path — zero achismo.
 * Lê virtusDelta.js e valida presença/consistência dos pontos críticos.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "scripts", "virtusDelta.js");
const src = fs.readFileSync(SRC, "utf8");
const issues = [];
const oks = [];

function mustInclude(label, re) {
  if (!re.test(src)) issues.push({ severity: "fail", label, detail: "missing_pattern" });
  else oks.push(label);
}
function mustNotInclude(label, re) {
  if (re.test(src)) issues.push({ severity: "fail", label, detail: "forbidden_pattern_present" });
  else oks.push(label);
}
function count(re) {
  return (src.match(re) || []).length;
}

// 1) Contrato único existe
mustInclude("DELTA_THREAD_PATH_PREFIX_RE", /const __DELTA_THREAD_PATH_PREFIX_RE\s*=/);
mustInclude("host_path_match", /function __deltaIsThreadKeyPathMatch\s*\(/);
mustInclude("browser_path_predicate", /function __deltaBrowserThreadPathMatchPredicate\s*\(/);
mustInclude("goto_url_builder", /function __deltaBuildThreadGotoUrlCandidates\s*\(/);
mustInclude("card_selector_builder", /function __deltaBuildThreadCardSelectors\s*\(/);

// 2) Regressão: wait pós-clique NÃO pode voltar ao includes("/messages")
mustNotInclude(
  "no_old_click_wait_messages_and_t",
  /return\s+path\.includes\(\s*["']\/messages["']\s*\)\s*&&\s*path\.includes\(/
);

// 3) waitForFunction deve usar predicate unificado (2x: click + patient)
const predUses = count(/__deltaBrowserThreadPathMatchPredicate/g);
if (predUses < 3) {
  // def + 2 uses minimum
  issues.push({ severity: "fail", label: "predicate_usage_count", detail: `count=${predUses} expected>=3` });
} else oks.push(`predicate_usage_count=${predUses}`);

// 4) Goto tem e2ee URLs
mustInclude("goto_has_e2ee", /messages\/e2ee\/t\/\$\{t\}/);
mustInclude("goto_has_classic", /messages\/t\/\$\{t\}/);

// 5) Soft requeue: não markNonRetryable em routing_recovery_exhausted final
const softBlock = src.includes("routing_recovery_exhausted_soft_requeue");
const badDead = /return\s+markNonRetryable\(\s*`routing_recovery_exhausted:/.test(src);
if (!softBlock) issues.push({ severity: "fail", label: "soft_requeue_log", detail: "missing" });
else oks.push("soft_requeue_log");
if (badDead) issues.push({ severity: "fail", label: "no_markNonRetryable_routing_exhausted", detail: "still_dead_letters" });
else oks.push("no_markNonRetryable_routing_exhausted");

// 6) Click-first: openThreadByClick ainda chama goto só no fallback
mustInclude("click_then_goto_fallback", /step_a_failed_fallback_goto/);
mustInclude("openThreadByClick_exists", /async function openThreadByClick\s*\(/);

// 7) probeOpenLine usa pathPrefixRe
mustInclude("probe_uses_pathPrefixRe", /pathPrefixRe/);

// 8) already open usa contrato amplo
mustInclude("already_open_e2ee_or_t", /\\\/e2ee\\\/t\\\/|\\\/t\\\//);

// 9) markNonRetryable ainda existe para erros reais de send
mustInclude("markNonRetryable_still_for_send", /composer_text_not_registered/);

// 10) Regressão: length>=18 order e2ee first in builders
const gotoBuilder = src.match(/function __deltaBuildThreadGotoUrlCandidates[\s\S]*?\n\}/);
if (!gotoBuilder) issues.push({ severity: "fail", label: "goto_builder_extract", detail: "fail" });
else {
  if (!/t\.length\s*>=\s*18\s*\?\s*\[\.\.\.e2ee,\s*\.\.\.classic\]/.test(gotoBuilder[0])) {
    issues.push({ severity: "fail", label: "goto_order_long_e2ee_first", detail: "order_wrong" });
  } else oks.push("goto_order_long_e2ee_first");
}

// 11) DELTA_GUARD: E2EE precisa de fbsbx/maw_proxy + messenger (não só facebook.com)
mustInclude("nav_firewall_helper", /function __deltaIsAllowedNavigationUrl\s*\(/);
mustInclude("nav_allows_fbsbx_maw_proxy", /host === "www\.fbsbx\.com" \|\| host === "fbsbx\.com"/);
mustInclude("nav_allows_messenger", /host === "www\.messenger\.com" \|\| host === "messenger\.com"/);
mustInclude("nav_firewall_uses_helper", /const isAllowedNavUrl = __deltaIsAllowedNavigationUrl/);
// Regressão: allowlist antiga só facebook.com (sem fbsbx) não pode voltar como único gate
mustNotInclude(
  "no_facebook_only_nav_allowlist",
  /const isAllowedNavUrl = \(rawUrl\) => \{\s*try \{\s*const u = new URL\(String\(rawUrl \|\| ""\)\);\s*const host = String\(u\.hostname \|\| ""\)\.toLowerCase\(\);\s*if \(\!\(host === "www\.facebook\.com" \|\| host === "facebook\.com"\)\) return false;\s*return true;/
);

// 12) Conteúdo indisponível: dead-letter (não soft-requeue / continue infinito)
mustInclude("content_unavailable_error", /error:\s*"thread_content_unavailable"/);
mustInclude("content_unavailable_nonretryable", /e === "thread_content_unavailable"/);
mustInclude(
  "content_unavailable_not_routing",
  /if \(e\.includes\("thread_content_unavailable"\)\) return false;/
);

console.log(JSON.stringify({
  file: SRC,
  bytes: src.length,
  ok_count: oks.length,
  issue_count: issues.length,
  oks,
  issues,
}, null, 2));
process.exit(issues.length ? 1 : 0);
