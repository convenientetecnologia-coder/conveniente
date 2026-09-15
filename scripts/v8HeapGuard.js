'use strict';

/**
 * Contrato V8 heap 8 GB. Nao mexe em Robe/Virtus.
 * --max-old-space-size=8192 no arranque. Trava recusa teto de fabrica (~2 GB).
 * heap_size_limit com 8192 MB de old space fica ~8 GB; folga da trava = 7 GB
 * para nao falso-positivo de alinhamento interno do V8.
 */

const fs = require('fs');
const path = require('path');
const v8 = require('v8');

const FLAG = '--max-old-space-size=8192';
const WANT_MB = 8192;
const MIN_HEAP_GB = 7;
const LOG_PATH = path.join(__dirname, '..', 'dados', 'logs', 'multi_engine.log');
const OK_STAMP = '[V8_HEAP_TUNED_OK] Processo validado com sucesso sob a bancada enterprise de 8 GB de Heap RAM.';
const ERR_STAMP = '[ERRO_FATAL_INFRA] O sistema tentou iniciar sem o colchão de 8 GB de RAM no V8! BOOT REJEITADO!';

function execArgv() {
  return [FLAG];
}

function spawnArgs(scriptAndRest) {
  const rest = Array.isArray(scriptAndRest) ? scriptAndRest.slice() : [scriptAndRest];
  return [FLAG].concat(rest);
}

function heapLimitBytes() {
  try {
    return Number(v8.getHeapStatistics().heap_size_limit) || 0;
  } catch {
    return 0;
  }
}

function heapLimitGB() {
  return heapLimitBytes() / 1024 / 1024 / 1024;
}

function writeEngineLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(LOG_PATH, ts + ' ' + String(line || '') + '\n', 'utf8');
  } catch {}
}

function assertEnterpriseHeap() {
  if (global.__CONVENIENTE_V8_HEAP_GUARD_DONE) return true;
  const gb = heapLimitGB();
  if (!(gb >= MIN_HEAP_GB)) {
    try {
      console.error('\x1b[31m' + ERR_STAMP + '\x1b[0m');
    } catch {}
    writeEngineLine(ERR_STAMP + ' heapLimitGB=' + gb.toFixed(3) + ' pid=' + process.pid);
    process.exit(1);
  }
  global.__CONVENIENTE_V8_HEAP_GUARD_DONE = true;
  writeEngineLine(OK_STAMP);
  writeEngineLine(
    '[V8_HEAP_TUNED_OK] heapLimitGB=' + gb.toFixed(3) +
    ' pid=' + process.pid +
    ' execArgv=' + JSON.stringify(process.execArgv || [])
  );
  return true;
}

module.exports = {
  FLAG,
  WANT_MB,
  MIN_HEAP_GB,
  OK_STAMP,
  ERR_STAMP,
  execArgv,
  spawnArgs,
  heapLimitBytes,
  heapLimitGB,
  assertEnterpriseHeap
};
