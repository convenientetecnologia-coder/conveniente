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

process.exit(fail ? 1 : 0);
