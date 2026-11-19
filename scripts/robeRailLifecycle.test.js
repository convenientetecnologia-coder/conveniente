'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'robeRail.js'), 'utf8');
function lifecycle(mocks) {
  const start = source.indexOf('async function closeIsolatedBrowser(');
  const end = source.indexOf('async function openRobeRail(', start);
  return vm.runInNewContext(source.slice(start, end) + '\n({closeIsolatedBrowser,launchIsolatedBrowser})', {
    setTimeout, clearTimeout, ...mocks
  });
}
test('fecha Puppeteer antes de permitir reutilização do perfil e dispensa kill de PID encerrado', async () => {
  const calls = [], proc = { pid: 42, exitCode: null, signalCode: null };
  const api = lifecycle({ killTree: async () => calls.push('kill') });
  await api.closeIsolatedBrowser({ process: () => proc, close: async () => { calls.push('close'); proc.exitCode = 0; } });
  assert.deepEqual(calls, ['close']);
});
test('força somente o processo isolado quando o fechamento falha', async () => {
  const calls = [];
  const api = lifecycle({ killTree: async pid => calls.push(pid) });
  await api.closeIsolatedBrowser({ process: () => ({pid: 42}), close: async () => { throw Error('disconnected'); } });
  assert.deepEqual(calls, [42]);
});
test('recupera singleton transitório na abertura, sem repetir ação de conta', async () => {
  let attempts = 0;
  const cleaned = [], config = { userDataDir: 'isolated-profile' }, browser = {};
  const api = lifecycle({
    accountPuppeteer: { launch: async received => {
      assert.equal(received, config);
      if (++attempts === 1) throw Error('The browser is already running for isolated-profile.');
      return browser;
    } },
    releaseProfileLocks: dir => cleaned.push(dir)
  });
  assert.equal(await api.launchIsolatedBrowser(config), browser);
  assert.equal(attempts, 2);
  assert.deepEqual(cleaned, ['isolated-profile']);
});
test('não mascara outros erros de abertura nem repete indefinidamente perfil ocupado', async () => {
  for (const message of ['bad executable', 'The browser is already running for isolated-profile.']) {
    let attempts = 0;
    const api = lifecycle({ accountPuppeteer: {launch: async () => { attempts++; throw Error(message); }}, releaseProfileLocks() {} });
    await assert.rejects(api.launchIsolatedBrowser({userDataDir:'isolated-profile'}), new RegExp(message.replace(/[.]/g, '\\.')));
    assert.equal(attempts, message === 'bad executable' ? 1 : 2);
  }
});

test('pedido antecipado de liberação mantém a cadeira enquanto o navegador móvel está aberto',async()=>{
 const start=source.indexOf('      async releaseProxy() {'),end=source.indexOf('      async destroy(opts)',start);
 const calls=[];
 const api=vm.runInNewContext('({'+source.slice(start,end)+'})',{proxyRequired:true,api:{backToDirect:async()=>calls.push('direct')},carrierOperation:{close:async()=>calls.push('release')},phoneUsed:false,require});
 await api.releaseProxy();assert.deepEqual(calls,[]);
});
