"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const contract = require("../scripts/deltaHistoryContract.js");

const base = 1_800_000_000_000;
const classify = (overrides = {}) => contract.classifyInbound({
  messageAt: base + 60_000,
  initializedAt: base,
  baselineGraceMs: 3_000,
  threadKnown: false,
  threadHighWatermark: 0,
  ...overrides,
});

assert.strictEqual(contract.INGEST_CONTRACT_VERSION, 2);
assert.strictEqual(classify().action, "accept", "primeiro chat após baseline deve entrar");
assert.strictEqual(
  classify({ messageAt: base + 1000 }).action,
  "accept",
  "timestamp Meta novo não pode cair na folga de boot"
);
assert.strictEqual(
  classify({
    messageAt: base + 1000,
    arrivalAt: base + 1000,
    messageTimestampTrusted: false,
  }).reason,
  "predates_account_baseline",
  "frame de boot sem timestamp deve usar a folga defensiva"
);
assert.strictEqual(
  classify({
    messageAt: base + 5000,
    arrivalAt: base + 5000,
    messageTimestampTrusted: false,
  }).action,
  "accept",
  "mensagem sem timestamp depois da folga deve falhar aberta"
);
assert.strictEqual(
  classify({ messageAt: base - 24 * 60 * 60 * 1000 }).reason,
  "predates_account_baseline",
  "caixa anterior à entrada da conta deve ser baseline"
);
assert.strictEqual(
  classify({ messageAt: base + 48 * 60 * 60 * 1000 }).action,
  "accept",
  "mensagem acumulada por 48h offline deve entrar"
);
assert.strictEqual(
  classify({
    messageAt: base + 2 * 24 * 60 * 60 * 1000,
    threadKnown: true,
    threadHighWatermark: base + 24 * 60 * 60 * 1000,
  }).action,
  "accept",
  "cliente que volta dias depois deve reativar"
);
assert.strictEqual(
  classify({
    messageAt: base + 24 * 60 * 60 * 1000,
    threadKnown: true,
    threadHighWatermark: base + 24 * 60 * 60 * 1000,
  }).reason,
  "thread_high_watermark_replay",
  "mesma mensagem não pode ser atendida novamente"
);

const worker = fs.readFileSync(path.join(__dirname, "..", "scripts", "worker.js"), "utf8");
assert(!worker.includes("outside_12h_lookback_window"), "worker ainda contém veto absoluto de 12h");
assert(!worker.includes("DELTA_HISTORY_LOOKBACK_MS"), "worker ainda calcula janela absoluta");
assert(worker.includes("deltaHistoryContract.classifyInbound"), "worker não usa o contrato v2");
assert(worker.includes("ingest_contract_version: DELTA_INGEST_CONTRACT_VERSION"), "fila CT sem versão v2");
assert(
  /function __deltaBuildCtIngestPayload[\s\S]{0,12000}ingest_contract_version:/.test(worker),
  "POST do CT não leva a versão do contrato"
);
assert(worker.includes("queuedDispatchCount > 0 && messageAt > 0"), "chat novo sem marca após persistência");

console.log("OK delta_history_contract_v2");
