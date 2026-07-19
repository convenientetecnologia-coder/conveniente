/**
 * Contrato do DELTA_GUARD — espelha __deltaIsAllowedNavigationUrl.
 * Roda standalone (sem Puppeteer) para regressão rápida.
 */
function __deltaIsAllowedNavigationUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    if (host === "www.facebook.com" || host === "facebook.com") return true;
    if (host === "www.messenger.com" || host === "messenger.com") return true;
    if (host === "www.fbsbx.com" || host === "fbsbx.com") {
      return path === "/maw_proxy_page" || path.startsWith("/maw_proxy_page/");
    }
    return false;
  } catch {
    return false;
  }
}

const cases = [
  { u: "https://www.facebook.com/messages/e2ee/t/7484430103067540775/", exp: true },
  { u: "https://www.facebook.com/messages/t/1666004214683318/", exp: true },
  { u: "https://facebook.com/messages/", exp: true },
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
  { u: "not-a-url", exp: false },
];

let fail = 0;
for (const c of cases) {
  const got = __deltaIsAllowedNavigationUrl(c.u);
  const ok = got === c.exp;
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", { got, exp: c.exp, u: c.u.slice(0, 90) });
}

// Fonte: virtusDelta deve exportar o mesmo contrato (existência + hosts).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "virtusDelta.js"), "utf8");
const checks = [
  [/function __deltaIsAllowedNavigationUrl\s*\(/, "helper_exists"],
  [/host === "www\.fbsbx\.com" \|\| host === "fbsbx\.com"/, "fbsbx_host"],
  [/path === "\/maw_proxy_page"/, "maw_proxy_path"],
  [/host === "www\.messenger\.com" \|\| host === "messenger\.com"/, "messenger_host"],
  [/const isAllowedNavUrl = __deltaIsAllowedNavigationUrl/, "firewall_uses_helper"],
];
for (const [re, label] of checks) {
  const ok = re.test(src);
  if (!ok) fail += 1;
  console.log(ok ? "OK" : "FAIL", "src:" + label);
}

process.exit(fail ? 1 : 0);
