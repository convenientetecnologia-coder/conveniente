'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const result of [{ ok: true, skipped: true, reason: 'no_action_needed_today' }, { ok: false, error: 'proxy_failed' }, { ok: true, humanRequired: true }]) {
  test('resultado comercial da postagem não pula ID; renovação respeita resultado do ID: ' + JSON.stringify(result), async () => {
    const calls = [], module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'robePostAttemptChecks.js'), 'utf8'), {
      module, require: name => {
        if (name === './stepLog') return { appendJSONL() {} };
        if (name === './robePostPublishId') return { BUDGET_TOTAL_MS: 420000, runRobeAutoId: async () => { calls.push('id'); return result; } };
        if (name === './robePostPublishRenew') return { runRobeAutoRenewSafe: async () => calls.push('renew_gate') };
        throw Error(name);
      }
    });
    const actual = await module.exports.run({ page: {}, nome: 'synthetic', attId: 'synthetic' });
    assert.equal(actual, result);
    assert.deepEqual(calls, result.ok === false || result.humanRequired ? ['id'] : ['id', 'renew_gate']);
  });
}

test('duplicata não produz publish_ok nem erro técnico e preserva a conferência de ID', () => {
  const source = fs.readFileSync(path.join(__dirname, 'robe.js'), 'utf8');
  const start = source.indexOf("    if (e && (e.message === 'publish_duplicate'");
  const end = source.indexOf("    logger.error('Erro em fluxo Robe'", start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  assert.ok(branch.includes("require('./robePostAttemptChecks').run"));
  assert.ok(branch.includes('published: false'));
  assert.equal(branch.includes("step: 'publish_ok'"), false);
});
