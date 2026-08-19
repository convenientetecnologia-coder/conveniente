"use strict";

/**
 * Hosts oficiais que o Facebook usa no Messenger web.
 * Goto nosso continua www.facebook.com/messages; o Facebook pode
 * redirecionar para web. / m. / mbasic. em IP móvel.
 * Hosts oficiais na lista fechada; curinga de subdomínio não entra.
 */

function hostnameOf(rawUrl) {
  try {
    return String(new URL(String(rawUrl || "")).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function pathnameOf(rawUrl) {
  try {
    return String(new URL(String(rawUrl || "")).pathname || "").toLowerCase();
  } catch {
    return "";
  }
}

function isOfficialFacebookNavHost(host) {
  const h = String(host || "").toLowerCase();
  return (
    h === "facebook.com" ||
    h === "www.facebook.com" ||
    h === "web.facebook.com" ||
    h === "m.facebook.com" ||
    h === "mbasic.facebook.com"
  );
}

function isOfficialMessengerNavHost(rawHost) {
  const host = String(rawHost || "").toLowerCase();
  return host === "www.messenger.com" || host === "messenger.com";
}

function isFbsbxMawProxyUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    if (host === "www.fbsbx.com" || host === "fbsbx.com") {
      return path === "/maw_proxy_page" || path.startsWith("/maw_proxy_page/");
    }
    return false;
  } catch {
    return false;
  }
}

function isAllowedDeltaNavigationUrl(rawUrl) {
  try {
    const host = hostnameOf(rawUrl);
    if (!host) return false;
    if (isOfficialFacebookNavHost(host)) return true;
    if (isOfficialMessengerNavHost(host)) return true;
    return isFbsbxMawProxyUrl(rawUrl);
  } catch {
    return false;
  }
}

function isLikelyMessagesBootUrl(rawUrl) {
  try {
    const host = hostnameOf(rawUrl);
    const path = pathnameOf(rawUrl);
    if (isOfficialMessengerNavHost(host)) return true;
    if (!isOfficialFacebookNavHost(host)) return false;
    return path.startsWith("/messages");
  } catch {
    return false;
  }
}

function isLiveMessagesUrl(rawUrl) {
  return isLikelyMessagesBootUrl(rawUrl);
}

function isFacebookLoginOrGateUrl(rawUrl) {
  try {
    const host = hostnameOf(rawUrl);
    const path = pathnameOf(rawUrl);
    if (!isOfficialFacebookNavHost(host) && !isOfficialMessengerNavHost(host)) return false;
    return /\/login|\/checkpoint|\/recover|\/two_factor|\/identity|\/consent|\/checkpoint\//i.test(path);
  } catch {
    return false;
  }
}

module.exports = {
  hostnameOf,
  isOfficialFacebookNavHost,
  isOfficialMessengerNavHost,
  isFbsbxMawProxyUrl,
  isAllowedDeltaNavigationUrl,
  isLikelyMessagesBootUrl,
  isLiveMessagesUrl,
  isFacebookLoginOrGateUrl
};
