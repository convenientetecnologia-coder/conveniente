"use strict";

/**
 * Um writer para dados/forensic_triagem.log.
 * Contrato: nao le o arquivo. Nao aloca 10 MB. Nao e fila em RAM.
 * Fila Delta / Virtus / robe / PIN nao passam daqui.
 *
 * Formato 1 (worker/virtusDelta): [SIGNATURE] {json}\n
 * Formato 2 (city collector): {json}\n
 * Teto 10 MB: rename para .1 .2 .3. A linha nova vai no arquivo novo.
 */

const fs = require("fs");
const path = require("path");
const { slim, MAX_LINE } = require("./auditAppend.js");

const DADOS = (function resolveDados() {
  const env = String(process.env.CONVENIENTE_DADOS_DIR || "").trim();
  return env ? path.resolve(env) : path.join(__dirname, "..", "dados");
})();

const FILE_PATH = path.join(DADOS, "forensic_triagem.log");
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;
const MAX_PENDING = 64;

let pending = 0;

function rotateIfHuge() {
  try {
    if (!fs.existsSync(FILE_PATH)) return false;
    const st = fs.statSync(FILE_PATH);
    const size = Number(st && st.size || 0) || 0;
    if (size < MAX_BYTES) return false;
    for (let i = KEEP; i >= 1; i -= 1) {
      const src = FILE_PATH + "." + i;
      const dst = FILE_PATH + "." + (i + 1);
      try {
        if (!fs.existsSync(src)) continue;
        if (i === KEEP) {
          try { fs.unlinkSync(src); } catch {}
          continue;
        }
        try { fs.renameSync(src, dst); } catch {}
      } catch {}
    }
    try { fs.renameSync(FILE_PATH, FILE_PATH + ".1"); } catch {}
    return true;
  } catch {
    return false;
  }
}

function writeLine(line) {
  const text = String(line || "");
  if (!text) return { ok: false, reason: "empty" };
  if (pending >= MAX_PENDING) return { ok: false, reason: "backpressure" };
  try { fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true }); } catch {}
  rotateIfHuge();
  pending += 1;
  fs.appendFile(FILE_PATH, text, "utf8", () => {
    pending = pending > 0 ? pending - 1 : 0;
  });
  return { ok: true };
}

function clipJson(body, extra) {
  let json = JSON.stringify(body);
  if (json.length <= MAX_LINE) return json;
  const fallback = Object.assign({
    timestamp: body && body.timestamp || Date.now(),
    ts: body && body.ts || Date.now(),
    clipped: true,
    bytes: json.length
  }, extra && typeof extra === "object" ? extra : {});
  return JSON.stringify(fallback);
}

function appendSigned(signature, details) {
  try {
    const sig = String(signature || "").trim();
    if (!sig) return { ok: false, reason: "nosig" };
    const payload = details && typeof details === "object" && !Array.isArray(details)
      ? details
      : { message: String(details == null ? "" : details) };
    const body = slim(Object.assign({ timestamp: Date.now() }, payload));
    const json = clipJson(body, { event: body.event || body.msg || sig });
    return writeLine("[" + sig + "] " + json + "\n");
  } catch {
    return { ok: false, reason: "throw" };
  }
}

function appendJson(obj) {
  try {
    const body = slim(obj && typeof obj === "object" ? obj : { ts: Date.now(), msg: "invalid" });
    if (body.ts == null) body.ts = Date.now();
    const json = clipJson(body, { tag: body.tag || "TRIAGEM_DOM", msg: body.msg || "clipped" });
    return writeLine(json + "\n");
  } catch {
    return { ok: false, reason: "throw" };
  }
}

module.exports = {
  FILE_PATH,
  MAX_BYTES,
  appendSigned,
  appendJson,
  rotateIfHuge
};
