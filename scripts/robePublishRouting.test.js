'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'robe.js'), 'utf8').replace(/\r/g, '');

async function phoneScenario({ sentBytes = 0, proveFails = false, transportOk = sentBytes > 0 } = {}) {
  let time = 0, bytes = 0;
  const events = [];
  const rail = {
    bytesToProxy: () => bytes,
    armAndProve: async () => {
      if (proveFails) return { ok: false };
      events.push('mobile'); bytes += 4096;
      return { ok: true, ip: '192.0.2.1', asn: 'AS22085' };
    },
    markPublishClick: () => events.push('baseline'),
    waitPublishTransport: async () => ({ ok: transportOk, listingIds: transportOk ? ['12345678901'] : [] }),
    backToDirect: async () => events.push('direct'),
    destroy: async () => { events.push('destroy_robe'); events.push('release'); }
  };
  const start = source.indexOf('async function publishAndWatch(');
  const end = source.indexOf('  // Logging array para rounds de dwell', start);
  const wStart = source.indexOf('async function waitPublishLeftProxy(');
  const wEnd = source.indexOf('async function clickFlowExactRetry(', wStart);
  const fn = vm.runInNewContext(source.slice(wStart, wEnd) + source.slice(start, end) + '\nreturn { proxySent };\n}\npublishAndWatch', {
    flowAlertFlags: { clearRobePostError: async () => {} },
    PUBLISH_OVERLAY_WATCH_MS: 0, Date: { now: () => time }, sleep: async ms => { time += ms; },
    attachLimitOverlaySentinel: async () => {}, setupGraphqlPublishWatcher: () => ({ cleanup() {} }),
    stepLog: { appendJSONL: (_n, _f, row) => events.push(row) },
    require: () => { throw Error('não deve comutar navegador do Virtus'); },
    clickFlowExactRetry: async (_p, _n, opts) => {
      await opts.onBeforePublish(); bytes += 4096;
      await opts.onPublishClick(); events.push('publish_click'); bytes += sentBytes;
      return { sequence: ['publicar'], publishClicked: true };
    }
  });
  try {
    return { result: await fn({ isClosed: () => false, browser: () => ({ __ctRobeRail: rail }) }, 'test', 'test'), events };
  } catch (error) { return { error, events }; }
}

test('prova de IP e tráfego anterior ao clique não confirmam envio do anúncio', async () => {
  const { result, events } = await phoneScenario();
  assert.equal(result.ok, false);
  assert.equal(result.proxySent, false);
  assert.equal(result.proxyRequired, true);
  assert.equal(result.bytes, 0);
  assert.equal(events.find(x => x.step === 'publish_left_proxy').ok, false);
});

test('envio pós-clique no celular aparece corretamente no registro final', async () => {
  const { result, events } = await phoneScenario({ sentBytes: 8192 });
  assert.equal(result.proxySent, true);
  const left = events.find(x => x.step === 'publish_left_proxy');
  assert.equal(left.bytes, 8192);
  assert.equal(result.robeClosed, true);
  assert.ok(events.indexOf('mobile') < events.indexOf('publish_click'));
  assert.ok(events.indexOf('destroy_robe') > events.indexOf('publish_click'));
});

test('resposta com ID confirma envio mesmo abaixo do antigo limiar de bytes', async () => {
  const { result } = await phoneScenario({ sentBytes: 1, transportOk: true });
  assert.equal(result.ok, true);
  assert.equal(result.listingId, '12345678901');
});

test('bytes sem conclusão da requisição não aprovam a postagem', async () => {
  const { result, events } = await phoneScenario({ sentBytes: 8192, transportOk: false });
  assert.equal(result.ok, false);
  assert.equal(result.proxySent, false);
  assert.equal(result.proxyRequired, true);
  assert.equal(events.includes('destroy_robe'), false);
});

test('falha ao provar IP impede clique e devolve a rede normal', async () => {
  const { error, events } = await phoneScenario({ proveFails: true });
  assert.equal(error.PROXY_PUBLISH, true);
  assert.equal(events.includes('publish_click'), false);
  assert.ok(events.includes('direct'));
});

test('envio rápido pelo rail é contado desde antes do clique', async () => {
  const start = source.indexOf('async function waitPublishLeftProxy(');
  const end = source.indexOf('async function clickFlowExactRetry(', start);
  let time = 0;
  const wait = vm.runInNewContext(source.slice(start, end) + '\nwaitPublishLeftProxy', {
    Date: { now: () => time }, sleep: async ms => { time += ms; }
  });
  const result = await wait({ bytesToProxy: () => 12288 }, 4096);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 8192);
  assert.equal((await wait({ bytesToProxy: () => 12288 })).ok, false);
});

test('Avançar precede a troca de rede; Publicar ocorre depois da prova e do marco de bytes', async () => {
  const start = source.indexOf('async function clickFlowExactRetry(');
  const end = source.indexOf('// --- O PATCH PRINCIPAL:', start);
  const events = [], actions = [{ kind: 'avancar', handle: 'avancar' }, { kind: 'publicar', handle: 'publicar' }];
  const click = vm.runInNewContext(source.slice(start, end) + '\nclickFlowExactRetry', {
    stepLog:{appendJSONL(){}},
    dismissListingError: async () => {}, dismissOpenListbox: async () => {}, sleep: async () => {},
    findFooterAction: async () => actions.shift(), clickOnce: async (_p, handle) => events.push(handle)
  });
  const result = await click({}, 'test', {
    onBeforePublish: async () => events.push('prove_mobile'), onPublishClick: async () => events.push('baseline')
  });
  assert.equal(result.publishClicked, true);
  assert.deepEqual(events, ['avancar', 'prove_mobile', 'baseline', 'publicar']);
});
