'use strict';

function isProxyFailure(value) {
  const text = String(value?.message || value || '');
  return /^proxy:/.test(text) || /phone_proxy_required:|(?:identity|renew)_proxy_|proxy_mobile_|publish_transport_not_confirmed|publish_not_left_proxy|ERR_(?:PROXY|TUNNEL|CONNECTION|SOCKS)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text);
}

function reason(reason, detail = '') {
  const raw = String(reason || 'flow_failed');
  return isProxyFailure(raw + ' ' + detail) ? 'proxy:' + raw.replace(/^proxy:/, '') : raw;
}

module.exports = { isProxyFailure, reason };
