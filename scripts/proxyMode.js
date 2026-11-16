'use strict';

function read() {
  try {
    const cfg = require('./serverConfig').readServerConfigEffective({});
    const mode = String(cfg && cfg.proxyMode || '').trim();
    if (mode === 'gen' || mode === 'phone') return mode;
  } catch {}
  return '';
}

module.exports = { read };
