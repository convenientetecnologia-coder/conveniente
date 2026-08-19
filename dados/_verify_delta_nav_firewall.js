/**
 * Contrato do DELTA_GUARD — usa facebookNavHosts (fonte única).
 * Roda standalone (sem Puppeteer) para regressão rápida.
 */
const fs = require("fs");
const path = require("path");
const facebookNavHosts = require("../scripts/facebookNavHosts.js");

function __deltaIsAllowedNavigationUrl(rawUrl) {
  return facebookNavHosts.isAllowedDeltaNavigationUrl(rawUrl);
}

const cases = [
  { u: "https://www.facebook.com/messages/e2ee/t/7484430103067540775/", exp: true },
  { u: "https://www.facebook.com/messages/t/1666004214683318/", exp: true },
  { u: "https://facebook.com/messages/", exp: true },
  { u: "https://web.facebook.com/messages?_rdc=1&_rdr#", exp: true },
  { u: "https://web.facebook.com/messages/", exp: true },
  { u: "https://m.facebook.com/messages/", exp: true },
  { u: "https://mbasic.facebook.com/messages/", exp: true },
  { u: "https://www.messenger.com/e2ee/t/7484430103067540775/", exp: true },
  { u: "https://www.messenger.com/t/1666004214683318/", exp: true },
  {
    u: "https://www.fbsbx.com/maw_proxy_page/?__cci=FQAR...XCometMessengerE2EEThreadController",
    exp: true,
  },
  {
    u: "https://fbsbx.com/maw_proxy_page/",
    exp: true,
  },
  { u: "https://www.fbsbx.com/evil", exp: false },
  { u: "https://www.fbsbx.com/", exp: false },
  { u: "https://evil.example/maw_proxy_page", exp: false },
  { u: "https://accounts.google.com/", exp: false },
  { u: "https://lm.facebook.com/l.php", exp: false },
  { u: "https://business.facebook.com/", exp: false },
  { u: "https://notfacebook.com/messages", exp: false },
  { u: "not-a-url", exp: false },
];

const bootCases = [
  { u: "https://www.facebook.com/messages", exp: true },
  { u: "https://web.facebook.com/messages?_rdc=1&_rdr#", exp: true },
  { u: "https://m.facebook.com/messages/", exp: true },
  { u: "https://mbasic.facebook.com/messages/", exp: true },
  { u: "https://www.messenger.com/t/1", exp: true },
  { u: "https://www.facebook.com/", exp: false },
  { u: "https://accounts.google.com/", exp: false },
];

let fail = 0;
for (const c of cases) {
  const got = __deltaIsAllowedNavigationUrl(c.u);
  const ok = got === c.exp;
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", { got, exp: c.exp, u: c.u.slice(0, 90) });
}

for (const c of bootCases) {
  const got = facebookNavHosts.isLikelyMessagesBootUrl(c.u);
  const ok = got === c.exp;
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", { kind: "boot", got, exp: c.exp, u: c.u.slice(0, 90) });
}

const srcDelta = fs.readFileSync(path.join(__dirname, "..", "scripts", "virtusDelta.js"), "utf8");
const srcHosts = fs.readFileSync(path.join(__dirname, "..", "scripts", "facebookNavHosts.js"), "utf8");
const checks = [
  [srcDelta, /function __deltaIsAllowedNavigationUrl\s*\(/, "helper_exists"],
  [srcDelta, /require\("\.\/facebookNavHosts\.js"\)/, "delta_uses_hosts_module"],
  [srcDelta, /const isAllowedNavUrl = __deltaIsAllowedNavigationUrl/, "firewall_uses_helper"],
  [srcHosts, /host === "www\.fbsbx\.com" \|\| host === "fbsbx\.com"/, "fbsbx_host"],
  [srcHosts, /path === "\/maw_proxy_page"/, "maw_proxy_path"],
  [srcHosts, /host === "www\.messenger\.com" \|\| host === "messenger\.com"/, "messenger_host"],
  [srcHosts, /h === "web\.facebook\.com"/, "web_facebook_host"],
  [srcHosts, /h === "m\.facebook\.com"/, "m_facebook_host"],
  [srcHosts, /h === "mbasic\.facebook\.com"/, "mbasic_facebook_host"],
];
for (const [hay, re, label] of checks) {
  const ok = re.test(hay);
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", "src:" + label);
}

if (/\*\.facebook\.com/.test(srcHosts) || /\*\.facebook\.com/.test(srcDelta)) {
  fail += 1;
  console.log("FAIL", "src:no_star_facebook_wildcard");
} else {
  console.log("OK", "src:no_star_facebook_wildcard");
}

if (/\.endsWith\(\s*["']facebook\.com["']\s*\)/.test(srcDelta)) {
  fail += 1;
  console.log("FAIL", "src:no_endswith_facebook_wildcard");
} else {
  console.log("OK", "src:no_endswith_facebook_wildcard");
}

if (!/isOfficialFacebookNavHost\(reqHost\)/.test(srcDelta)) {
  fail += 1;
  console.log("FAIL", "src:boot_interlock_official_hosts");
} else {
  console.log("OK", "src:boot_interlock_official_hosts");
}

const suffixTrap = "notfacebook.com";
const officialTrap = facebookNavHosts.isOfficialFacebookNavHost(suffixTrap);
const suffixWouldMatch = suffixTrap.endsWith("facebook.com");
if (suffixWouldMatch && !officialTrap) {
  console.log("OK", "host:notfacebook_suffix_trap");
} else {
  fail += 1;
  console.log("FAIL", "host:notfacebook_suffix_trap", { suffixWouldMatch, officialTrap });
}

const loginCases = [
  { u: "https://www.facebook.com/login.php", exp: true },
  { u: "https://web.facebook.com/checkpoint/", exp: true },
  { u: "https://m.facebook.com/identity", exp: true },
  { u: "https://web.facebook.com/messages", exp: false },
];
for (const c of loginCases) {
  const got = facebookNavHosts.isFacebookLoginOrGateUrl(c.u);
  const ok = got === c.exp;
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", { kind: "login", got, exp: c.exp, u: c.u });
}

const hygiene = require("../scripts/robeTabHygiene.js");
const errCases = [
  { t: "ERR_TUNNEL_CONNECTION_FAILED\nNao e possivel acessar esse site", exp: true },
  { t: "ERR_BLOCKED_BY_CLIENT", exp: true },
  { t: "Não é possível acessar esse site", exp: true },
  { t: "This site can’t be reached", exp: true },
  { t: "Esta página da web foi bloqueada", exp: true },
  { t: "João: took too long to respond\nMessenger", exp: false },
  { t: "this page has been blocked by the group admin", exp: false },
  { t: "Marketplace", exp: false },
];
for (const c of errCases) {
  const got = hygiene.isChromeErrorUiText(c.t);
  const ok = got === c.exp;
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", { kind: "chrome_err", got, exp: c.exp, t: c.t.slice(0, 60) });
}

const liveOk = hygiene.isLiveWorkUrl("https://web.facebook.com/messages");
const liveBad = hygiene.isLiveWorkUrl("https://notfacebook.com/messages") || hygiene.isLiveWorkUrl("https://business.facebook.com/");
if (liveOk && !liveBad) console.log("OK", "hygiene:live_work_official_only");
else {
  fail += 1;
  console.log("FAIL", "hygiene:live_work_official_only", { liveOk, liveBad });
}

const srcHygiene = fs.readFileSync(path.join(__dirname, "..", "scripts", "robeTabHygiene.js"), "utf8");
const srcWorker = fs.readFileSync(path.join(__dirname, "..", "scripts", "worker.js"), "utf8");
if (/#main-frame-error/.test(srcHygiene) && !/\.error-code|#error-code/.test(srcHygiene)) {
  console.log("OK", "src:chrome_error_dom_ids_only");
} else {
  fail += 1;
  console.log("FAIL", "src:chrome_error_dom_ids_only");
}
if (/needsEntry = isJunkUrl\(u0\)/.test(srcWorker) && /pageLooksLikeChromeNetError\(p0\)/.test(srcWorker)) {
  console.log("OK", "src:open_entry_retries_junk_or_dead");
} else {
  fail += 1;
  console.log("FAIL", "src:open_entry_retries_junk_or_dead");
}

(async () => {
  const pDead = {
    url: () => "https://web.facebook.com/messages?_rdc=1&_rdr#",
    title: async () => "web.facebook.com",
    evaluate: async () => ({ dom: true, text: "" }),
    isClosed: () => false
  };
  const pLive = {
    url: () => "https://web.facebook.com/messages?_rdc=1&_rdr#",
    title: async () => "Messenger",
    evaluate: async () => ({ dom: false, text: "Chats" }),
    isClosed: () => false
  };
  const keep = await hygiene.pickVirtusKeepPageAsync([pDead, pLive], pDead);
  if (keep === pLive) console.log("OK", "hygiene:keep_live_over_dead_web_messages");
  else {
    fail += 1;
    console.log("FAIL", "hygiene:keep_live_over_dead_web_messages");
  }
  const deadLooks = await hygiene.pageLooksLikeChromeNetError(pDead);
  const liveLooks = await hygiene.pageLooksLikeChromeNetError(pLive);
  if (deadLooks === true && liveLooks === false) console.log("OK", "hygiene:dead_probe_dom_vs_live");
  else {
    fail += 1;
    console.log("FAIL", "hygiene:dead_probe_dom_vs_live", { deadLooks, liveLooks });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("FAIL", "async_hygiene_probe", String(e && e.message || e));
  process.exit(1);
});
