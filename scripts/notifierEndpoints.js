"use strict";

// Centraliza a origem do endpoint do notificador (sitechatbot).
// Importante: mantemos compatível com a versão atual que usa ngrok.

function resolveEndpoints() {
  // Preferência máxima: CT_BASE_URL/CT_URL (base do CT). Isso evita depender de ngrok hardcoded.
  // Ex.: CT_BASE_URL=https://xxxx.ngrok-free.app  => endpoint report = {base}/report
  const base = String(process.env.CT_BASE_URL || process.env.CT_URL || "").trim();
  if (base) {
    const b = base.replace(/\/+$/, "");
    return [`${b}/report`];
  }

  // Permite override por env (para futuro multi-ambiente).
  const env = String(process.env.CT_NOTIFIER_REPORT_URL || process.env.NOTIFIER_REPORT_URL || "").trim();
  if (env) return [env];
  return [
    "https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io/report"
  ];
}

function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || "";
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

module.exports = { resolveEndpoints, notifierBaseFromEndpoints };

