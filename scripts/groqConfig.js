"use strict";

// scripts/groqConfig.js
// Config local (por host) para integrações externas (ex.: Groq).
// Regra enterprise: arquivo em dados/ é ignorado pelo git (cada host tem o seu).

const fs = require("fs");
const path = require("path");

const GROQ_CONFIG_PATH = path.join(__dirname, "..", "dados", "groq_config.json");

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) return null;
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : null;
  } catch {
    return null;
  }
}

// Meta (não sensível): usado para telemetria / handshake.
function readGroqConfigMeta() {
  const j = safeReadJson(GROQ_CONFIG_PATH) || {};
  const fileModel = String(j.groqModel || "").trim();
  const fileKeyPresent = !!String(j.groqApiKey || "").trim();
  const fileUpdatedAt = Number(j.updatedAt || 0) || 0;

  const envModel = String(process.env.GROQ_MODEL || "").trim();
  const envKeyPresent = !!String(process.env.GROQ_API_KEY || "").trim();

  // Regra: runtime usa arquivo (se existir) com prioridade mais alta.
  const effectiveSource = (fileModel || fileKeyPresent) ? "file" : ((envModel || envKeyPresent) ? "env" : "none");
  const effectiveModel = fileModel || envModel || "";
  const effectiveApiKeyPresent = fileKeyPresent || envKeyPresent;

  return {
    ok: true,
    path: GROQ_CONFIG_PATH,
    effectiveSource,
    effectiveModel,
    effectiveModelPresent: !!effectiveModel,
    effectiveApiKeyPresent: !!effectiveApiKeyPresent,
    file: { present: !!(fileModel || fileKeyPresent), model: fileModel, apiKeyPresent: fileKeyPresent, updatedAt: fileUpdatedAt || null },
    env: { present: !!(envModel || envKeyPresent), model: envModel, apiKeyPresent: envKeyPresent }
  };
}

function readGroqConfig() {
  const j = safeReadJson(GROQ_CONFIG_PATH) || {};
  // Enterprise: permitir fallback via env (útil quando o host é provisionado com variáveis
  // mas ainda não escreveu o arquivo local).
  const envKey = String(process.env.GROQ_API_KEY || "").trim();
  const envModel = String(process.env.GROQ_MODEL || "").trim();
  const groqApiKey = String(j.groqApiKey || envKey || "").trim();
  const groqModel = String(j.groqModel || envModel || "").trim();
  return {
    ok: true,
    path: GROQ_CONFIG_PATH,
    groqApiKey: groqApiKey || "",
    groqModel: groqModel || ""
  };
}

function writeGroqConfig({ groqApiKey, groqModel } = {}) {
  try {
    const cur = readGroqConfig();
    const next = {
      groqApiKey: (groqApiKey !== undefined) ? String(groqApiKey || "").trim() : (cur.groqApiKey || ""),
      groqModel: (groqModel !== undefined) ? String(groqModel || "").trim() : (cur.groqModel || ""),
      updatedAt: Date.now()
    };
    fs.mkdirSync(path.dirname(GROQ_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GROQ_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
    return { ok: true, path: GROQ_CONFIG_PATH };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { GROQ_CONFIG_PATH, readGroqConfig, readGroqConfigMeta, writeGroqConfig };

