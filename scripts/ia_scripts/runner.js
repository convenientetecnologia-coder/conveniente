// scripts/ia_scripts/runner.js

/**
 * Runner de QA: executa casos de teste (JSON) para um handler/step isolado
 * Exemplo de uso (node):
 *   node scripts/ia_scripts/runner.js --step telefone --cases scripts/qa/cases/telefone
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const reg = require('./registry');
const core = require('./core');

// Aqui registre os steps/handlers necessários para o teste rápido
// Exemplo: (basta registrar os steps que serão testados)
require('./telefone').register(reg);
require('./itens').register(reg);
require('./endereco_saida').register(reg);
require('./endereco_destino').register(reg);
require('./ajudante').register(reg);
require('./descricao').register(reg);
require('./saudacao').register(reg);

(async function () {
  const argv = minimist(process.argv.slice(2));
  const stepId = argv.step || 'telefone';
  const dir = path.resolve(argv.cases || `scripts/qa/cases/${stepId}`);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  let ok = 0, fail = 0;
  for (const f of files) {
    const test = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    // test: { historico: [...], data: {...}, expectAskIncludes: '', expectNext: '' }
    const ctx = {
      perfil: 'teste', chatId: 'qa',
      data: test.data || {},
      flags: test.flags || {},
      historico: test.historico || [],
      cidade: test.cidade || null,
      lastClient: null,
      audit: {}
    };
    try {
      const out = await core.runStep(ctx, stepId, 1);
      const askTxt = out.ask || '';
      const next = out.next && out.next.stepId;
      const askOk = !test.expectAskIncludes || askTxt.includes(test.expectAskIncludes);
      const nextOk = !test.expectNext || next === test.expectNext;
      if (askOk && nextOk) {
        ok++;
      } else {
        fail++;
        console.log('[FAIL]', f, { askIncludes: askOk, nextOk, askTxt, next });
      }
    } catch (e) {
      fail++;
      console.log('[ERROR]', f, e && e.message || e);
    }
  }
  console.log(`QA ${stepId}: OK=${ok} FAIL=${fail} total=${ok + fail}`);
  process.exit(fail ? 1 : 0);
})();