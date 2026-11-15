"use strict";

const { readCtConfig } = require("./ctConfig.js");

const DEFAULT_ANTICAPTCHA_BASE = "https://api.anti-captcha.com";

function readAntiCaptchaConfig() {
  const cfg = readCtConfig();
  const apiKey = String(process.env.ANTICAPTCHA_API_KEY || (cfg && cfg.antiCaptchaApiKey) || "").trim();
  const baseUrl = String(process.env.ANTICAPTCHA_BASE_URL || (cfg && cfg.antiCaptchaBaseUrl) || DEFAULT_ANTICAPTCHA_BASE).trim().replace(/\/+$/, "") || DEFAULT_ANTICAPTCHA_BASE;
  return {
    ok: true,
    apiKey,
    baseUrl
  };
}

async function antiCaptchaPost(path, payload, { timeoutMs = 20_000 } = {}) {
  const cfg = readAntiCaptchaConfig();
  if (!cfg.apiKey) return { ok: false, error: "anticaptcha_config_missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs || 0) || 20_000));
  try {
    const resp = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: cfg.apiKey,
        ...(payload && typeof payload === "object" ? payload : {})
      }),
      signal: controller.signal
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json || typeof json !== "object") {
      return { ok: false, error: `anticaptcha_http_${resp.status}` };
    }
    if (Number(json.errorId || 0) !== 0) {
      return {
        ok: false,
        error: "anticaptcha_api_error",
        errorCode: String(json.errorCode || "").trim() || null,
        errorDescription: String(json.errorDescription || "").trim() || null
      };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: (e && e.name === "AbortError") ? "anticaptcha_timeout" : ((e && e.message) ? String(e.message) : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

async function getBalance() {
  const res = await antiCaptchaPost("/getBalance", {}, { timeoutMs: 15_000 });
  if (!res.ok) return res;
  return {
    ok: true,
    balance: Number(res.data && res.data.balance) || 0
  };
}

async function createImageToTextTask(imageBase64) {
  const body = String(imageBase64 || "").trim();
  if (!body) return { ok: false, error: "captcha_image_empty" };
  const res = await antiCaptchaPost("/createTask", {
    softId: 0,
    task: {
      type: "ImageToTextTask",
      body,
      phrase: false,
      case: true,
      numeric: 0,
      math: false,
      minLength: 4,
      maxLength: 8,
      comment: "Digite os caracteres da imagem, da esquerda para a direita.",
      websiteURL: "https://www.facebook.com/"
    }
  }, { timeoutMs: 20_000 });
  if (!res.ok) return res;
  return {
    ok: true,
    taskId: Number(res.data && res.data.taskId) || 0
  };
}

async function getTaskResult(taskId) {
  const id = Number(taskId || 0) || 0;
  if (!id) return { ok: false, error: "anticaptcha_task_id_missing" };
  const res = await antiCaptchaPost("/getTaskResult", { taskId: id }, { timeoutMs: 20_000 });
  if (!res.ok) return res;
  const status = String(res.data && res.data.status || "").trim().toLowerCase();
  if (status === "processing") {
    return { ok: true, ready: false };
  }
  const solutionText = String(res.data && res.data.solution && res.data.solution.text || "").trim();
  return {
    ok: true,
    ready: status === "ready",
    text: solutionText,
    cost: res.data && res.data.cost != null ? Number(res.data.cost) : null
  };
}

async function solveImageCaptcha(imageBase64, { maxWaitMs = 110_000, pollMs = 3_000 } = {}) {
  const cfg = readAntiCaptchaConfig();
  if (!cfg.apiKey) return { ok: false, error: "anticaptcha_config_missing" };

  const balance = await getBalance();
  if (!balance.ok) return balance;
  if (!(Number(balance.balance || 0) > 0)) {
    return { ok: false, error: "anticaptcha_zero_balance" };
  }

  const created = await createImageToTextTask(imageBase64);
  if (!created.ok) {
    const code = String(created.errorCode || "").trim();
    if (code === "ERROR_ZERO_BALANCE") return { ok: false, error: "anticaptcha_zero_balance" };
    if (code === "ERROR_KEY_DOES_NOT_EXIST") return { ok: false, error: "anticaptcha_key_invalid" };
    return created;
  }

  const taskId = Number(created.taskId || 0) || 0;
  if (!taskId) return { ok: false, error: "anticaptcha_task_id_missing" };

  const startedAt = Date.now();
  const timeoutMs = Math.max(10_000, Number(maxWaitMs || 0) || 110_000);
  const intervalMs = Math.max(1_000, Number(pollMs || 0) || 3_000);
  while ((Date.now() - startedAt) < timeoutMs) {
    const result = await getTaskResult(taskId);
    if (!result.ok) {
      if (String(result.error || "").toLowerCase() === "anticaptcha_timeout") {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      return { ok: false, error: result.error || "anticaptcha_task_failed", taskId };
    }
    if (!result.ready) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    const clean = String(result.text || "").replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "").trim();
    if (clean.length < 4 || clean.length > 8) {
      return {
        ok: false,
        error: "anticaptcha_text_bad_length",
        taskId,
        cost: result.cost != null ? Number(result.cost) : null,
        textLength: clean.length
      };
    }
    return {
      ok: true,
      taskId,
      text: clean,
      cost: result.cost != null ? Number(result.cost) : null,
      textLength: clean.length
    };
  }

  return { ok: false, error: "anticaptcha_timeout", taskId };
}

async function solveRecaptchaEnterprise({
  websiteURL,
  websiteKey,
  enterpriseS,
  isInvisible,
  userAgent,
  timeoutMs = 90_000,
  taskType
} = {}) {
  const cfg = readAntiCaptchaConfig();
  if (!cfg.apiKey) return { ok: false, error: "anticaptcha_key_missing" };
  const sitekey = String(websiteKey || "").trim();
  const pageUrl = String(websiteURL || "https://www.fbsbx.com/").trim();
  if (!sitekey || !pageUrl) return { ok: false, error: "recaptcha_widget_incomplete" };
  const type = taskType || "RecaptchaV2EnterpriseTaskProxyless";
  const task = {
    type,
    websiteURL: pageUrl,
    websiteKey: sitekey,
    isInvisible: isInvisible === true
  };
  const ua = String(userAgent || "").trim();
  if (ua) task.userAgent = ua;
  const s = String(enterpriseS || "").trim();
  if (s && type === "RecaptchaV2EnterpriseTaskProxyless") task.enterprisePayload = { s };
  if (s && type === "RecaptchaV2TaskProxyless") task.recaptchaDataSValue = s;
  const created = await antiCaptchaPost("/createTask", { softId: 0, task }, { timeoutMs: 20_000 });
  if (!created.ok) {
    const code = String(created.errorCode || "").trim();
    if (code === "ERROR_ZERO_BALANCE") return { ok: false, error: "ERROR_ZERO_BALANCE" };
    if (code === "ERROR_KEY_DOES_NOT_EXIST") return { ok: false, error: "ERROR_KEY_DOES_NOT_EXIST" };
    return { ok: false, error: code || created.error || "create_task_failed" };
  }
  const taskId = Number(created.data && created.data.taskId) || 0;
  if (!taskId) return { ok: false, error: "anticaptcha_task_id_missing" };
  const started = Date.now();
  const limit = Math.max(10_000, Number(timeoutMs || 0) || 90_000);
  while ((Date.now() - started) < limit) {
    const res = await antiCaptchaPost("/getTaskResult", { taskId }, { timeoutMs: 20_000 });
    if (!res.ok) {
      if (String(res.error || "") === "anticaptcha_timeout") {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return { ok: false, error: res.error || "anticaptcha_task_failed", taskId };
    }
    const status = String(res.data && res.data.status || "").trim().toLowerCase();
    if (status !== "ready") {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const token = String(res.data && res.data.solution && res.data.solution.gRecaptchaResponse || "").trim();
    if (token.length < 20) return { ok: false, error: "empty_token", taskId };
    return {
      ok: true,
      token,
      taskId,
      cost: res.data && res.data.cost != null ? Number(res.data.cost) : null
    };
  }
  return { ok: false, error: "anticaptcha_timeout", taskId, waitedMs: Date.now() - started };
}

async function solveRecaptchaV2(opts) {
  return solveRecaptchaEnterprise(Object.assign({}, opts || {}, { taskType: "RecaptchaV2TaskProxyless" }));
}

async function solveFunCaptcha({
  websiteURL,
  websitePublicKey,
  funcaptchaApiJSSubdomain,
  userAgent,
  timeoutMs = 120_000
} = {}) {
  const cfg = readAntiCaptchaConfig();
  if (!cfg.apiKey) return { ok: false, error: "anticaptcha_key_missing" };
  const publicKey = String(websitePublicKey || "").trim();
  const pageUrl = String(websiteURL || "").trim();
  const subdomain = String(funcaptchaApiJSSubdomain || "").trim();
  if (!publicKey || !pageUrl || !subdomain) return { ok: false, error: "funcaptcha_widget_incomplete" };
  const task = {
    type: "FunCaptchaTaskProxyless",
    websiteURL: pageUrl,
    websitePublicKey: publicKey,
    funcaptchaApiJSSubdomain: subdomain
  };
  const ua = String(userAgent || "").trim();
  if (ua) task.userAgent = ua;
  const created = await antiCaptchaPost("/createTask", { softId: 0, task }, { timeoutMs: 20_000 });
  if (!created.ok) {
    const code = String(created.errorCode || "").trim();
    if (code === "ERROR_ZERO_BALANCE") return { ok: false, error: "ERROR_ZERO_BALANCE" };
    if (code === "ERROR_KEY_DOES_NOT_EXIST") return { ok: false, error: "ERROR_KEY_DOES_NOT_EXIST" };
    return { ok: false, error: code || created.error || "create_task_failed" };
  }
  const taskId = Number(created.data && created.data.taskId) || 0;
  if (!taskId) return { ok: false, error: "anticaptcha_task_id_missing" };
  const started = Date.now();
  const limit = Math.max(10_000, Number(timeoutMs || 0) || 120_000);
  while ((Date.now() - started) < limit) {
    const res = await antiCaptchaPost("/getTaskResult", { taskId }, { timeoutMs: 20_000 });
    if (!res.ok) {
      if (String(res.error || "") === "anticaptcha_timeout") {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return { ok: false, error: res.error || "anticaptcha_task_failed", taskId };
    }
    const status = String(res.data && res.data.status || "").trim().toLowerCase();
    if (status !== "ready") {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const token = String(res.data && res.data.solution && res.data.solution.token || "").trim();
    if (token.length < 20) return { ok: false, error: "empty_token", taskId };
    return {
      ok: true,
      token,
      taskId,
      cost: res.data && res.data.cost != null ? Number(res.data.cost) : null
    };
  }
  return { ok: false, error: "anticaptcha_timeout", taskId, waitedMs: Date.now() - started };
}

module.exports = {
  DEFAULT_ANTICAPTCHA_BASE,
  readAntiCaptchaConfig,
  getBalance,
  createImageToTextTask,
  getTaskResult,
  solveImageCaptcha,
  solveRecaptchaEnterprise,
  solveRecaptchaV2,
  solveFunCaptcha
};
