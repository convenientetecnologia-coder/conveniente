'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module, exports: module.exports, require: name => {
      if(name==='./carrierV2/clock')return require('./carrierV2/clock');
      if (!(name in mocks)) throw Error('unexpected dependency: ' + name);
      return mocks[name];
    }
  });
  return module.exports;
}

test('shared publish chair runs ID then renewal on the existing page without opening or closing a rail', async () => {
  const api=load('isolatedAccountFlow.js',{}),calls=[];
  const browser={},page={browser:()=>browser};
  const rail={withStage:async(kind,action)=>{const previous=browser.__ctIsolatedFlow;browser.__ctIsolatedFlow={kind,rail,shared:true};calls.push(kind);try{return await action()}finally{browser.__ctIsolatedFlow=previous}},confirmIdentity:()=>calls.push('identity-confirmed')};
  browser.__ctIsolatedFlow={kind:'publish',rail};
  await api.run({page,nome:'test',kind:'id'},async received=>{assert.equal(received,page);assert.equal(api.context(page,'id').shared,true);return {ok:true,marked:true}});
  await api.run({page,nome:'test',kind:'renew'},async received=>{assert.equal(received,page);return {ok:true}});
  assert.deepEqual(calls,['id','identity-confirmed','renew']);assert.equal(browser.__ctIsolatedFlow.kind,'publish');
  await assert.rejects(api.run({page,nome:'test',kind:'id'},async()=>{throw Error('network-lost')}),/network-lost/);
  assert.equal(calls.filter(x=>x==='identity-confirmed').length,1);
});

for (const proxyRequired of [true, false]) {
  for (const fails of [true, false]) {
    test(`isolamento e fechamento: proxy=${proxyRequired}, erro=${fails}`, async () => {
      const calls = [], sourceBrowser = {}, isolatedPage = {};
      const api = load('isolatedAccountFlow.js', {
        './manifestStore': { read: async () => ({ cookies: [] }) },
        './serverConfig': { readServerConfigEffective: () => ({ robe: { publishWithProxy: proxyRequired } }) },
        './robeRail': { openRobeRail: async opts => {
          assert.equal(opts.proxyRequired, proxyRequired);
          assert.equal(opts.liveBrowser, sourceBrowser);
          calls.push('open');
          return { browser: { pages: async () => [isolatedPage] }, destroy: async () => calls.push('close') };
        } }
      });
      const operation = api.run({ page: { browser: () => sourceBrowser }, nome: 'synthetic', kind: 'id' }, async page => {
        assert.equal(page, isolatedPage); calls.push('action');
        if (fails) throw Error('synthetic');
        return { ok: true };
      });
      if (fails) await assert.rejects(operation, /synthetic/);
      else assert.equal((await operation).ok, true);
      assert.deepEqual(calls, ['open', 'action', 'close']);
    });
  }
}

test('ID não aceita wizard com proxy exigido mas não armado', async () => {
  const api = load('isolatedAccountFlow.js', {});
  const rail = { isProxyArmed: false, armAndProve: async () => ({ ok: false }) };
  const page = { browser: () => ({ __ctIsolatedFlow: { kind: 'id', proxyRequired: true, rail } }) };
  await assert.rejects(api.armIdentity(page), /identity_proxy_unavailable/);
  rail.armAndProve = async () => { rail.isProxyArmed = true; return { ok: true }; };
  await api.armIdentity(page);
});

test('ID concluído pula antes de acessar página ou abrir navegador', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'robePostPublishId.js'), 'utf8');
  const start = source.indexOf('async function runRobeAutoId(');
  const end = source.indexOf('  const startedAt = Date.now();', start);
  const fn = vm.runInNewContext(source.slice(start, end) + '\n}\nrunRobeAutoId', {
    isDoneToday: async () => true,
    require: () => { throw Error('não deve abrir navegador'); }
  });
  const result = await fn({ nome: 'synthetic', page: null });
  assert.equal(result.reason, 'already_done_today');
});

test('renovação fora do horário não abre navegador e não marca concluído', async () => {
  const api = load('robePostPublishRenew.js', {
    './marketplaceRenewListings.js': { runMarketplaceRenewListings: async () => { throw Error('não deve abrir'); } },
    './marketplaceRenewPlan.js': { shouldAutoRenewAfterPublish: async () => ({ shouldRun: false, reason: 'before_due_time' }), todaySaoPaulo: () => '2026-11-18' },
    './flowAlertFlags.js': {}, './provisionAudit.js': { append() {} },
    './stepLog.js': { appendJSONL() {} }, './logger.js': { info() {} }
  });
  const result = await api.runRobeAutoRenew({ page: {}, nome: 'synthetic' });
  assert.equal(result.skipped, true);
  assert.equal(result.marked, false);
  assert.equal(result.reason, 'before_due_time');
});

test('ID isolado não usa rotação/fallback de envio legado', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'robePostPublishId.js'), 'utf8');
  const start = source.indexOf('async function runIdDocWithFallback(');
  const end = source.indexOf('async function runRobeAutoId(', start);
  const calls = [];
  const fn = vm.runInNewContext(source.slice(start, end) + '\nrunIdDocWithFallback', {
    require: () => ({ context: () => ({ proxyRequired: true, rail: { isProxyArmed: true } }) }),
    runIdDocWizard: async (_p, opts) => { calls.push(opts.network); return { ok: false, error: 'proxy_mobile_unavailable' }; }
  });
  const result = await fn({}, {});
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['isolated']);
});

test('renovação conecta só após localizar botão real e relê posição antes do clique', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'marketplaceRenewListings.js'), 'utf8');
  const start = source.indexOf('async function clickRenewConfirmInDialog(');
  const end = source.indexOf('async function clickRenewConfirm(', start);
  const calls = [];
  const fn = vm.runInNewContext(source.slice(start, end) + '\nclickRenewConfirmInDialog', {
    require:()=>({waitControl:async()=>({ok:true})}),
    safeEvaluate: async () => { calls.push('find'); return { ok: true, x: 12, y: 20 }; },
    humanPause: async () => {}, randInt: () => 1
  });
  const page = { evaluate: async () => {}, mouse: { move: async () => {}, click: async () => calls.push('click') } };
  const result = await fn(page, { beforeClick: async () => calls.push('proxy'), onClick: async () => calls.push('baseline') });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['find', 'proxy', 'find', 'baseline', 'click']);
});
