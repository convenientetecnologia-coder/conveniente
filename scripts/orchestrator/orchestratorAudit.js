"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = path.join(__dirname, "..", "..", "dados");
const AUDIT_PATH = path.join(DATA_DIR, "orchestrator_audit.jsonl");

function envFlag(name, defaultValue) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return !!defaultValue;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return !!defaultValue;
}

function enabled() {
  return envFlag("WORKER_ORCH_AUDIT", true);
}

function sampleAllowed() {
  const rate = Math.max(0, Math.min(1, Number(process.env.WORKER_ORCH_AUDIT_SAMPLE_RATE || "1") || 1));
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() <= rate;
}

function trimString(value, max) {
  const s = String(value == null ? "" : value);
  return s.length > max ? s.slice(0, max) : s;
}

function sanitize(value, depth = 0) {
  const maxDepth = Math.max(1, Number(process.env.WORKER_ORCH_AUDIT_MAX_DEPTH || "4") || 4);
  const maxString = Math.max(80, Number(process.env.WORKER_ORCH_AUDIT_MAX_STRING || "400") || 400);
  if (depth > maxDepth) return "[max_depth]";
  if (value == null) return value;
  if (typeof value === "string") return trimString(value, maxString);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: trimString(value.message, maxString) };
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).slice(0, 80);
    for (const [k, v] of entries) {
      const key = trimString(k, 80);
      if (/cookie|password|token|secret|authorization|api[_-]?key/i.test(key)) {
        out[key] = v ? "[redacted]" : v;
      } else {
        out[key] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return trimString(value, maxString);
}

function append(event, data = {}) {
  try {
    if (!enabled() || !sampleAllowed()) return false;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const maxBytes = Math.max(512, Number(process.env.WORKER_ORCH_AUDIT_MAX_EVENT_BYTES || "4096") || 4096);
    const obj = {
      ts: Date.now(),
      event: String(event || "unknown").slice(0, 120),
      pid: process.pid,
      host: os.hostname(),
      data: sanitize(data)
    };
    let line = JSON.stringify(obj);
    if (Buffer.byteLength(line, "utf8") > maxBytes) {
      obj.data = {
        truncated: true,
        originalEvent: obj.event,
        preview: trimString(line, maxBytes - 200)
      };
      line = JSON.stringify(obj);
    }
    fs.appendFileSync(AUDIT_PATH, line + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function begin(actor, data = {}) {
  const startedAt = Date.now();
  append("runtime_actor_tick_begin", { actor, ...data });
  return {
    actor,
    startedAt,
    end(extra = {}) {
      append("runtime_actor_tick_end", {
        actor,
        durationMs: Date.now() - startedAt,
        ...extra
      });
    }
  };
}

module.exports = {
  AUDIT_PATH,
  append,
  begin,
  enabled
};
