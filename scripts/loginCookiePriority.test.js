'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r/g, '');

for (const mode of ['', 'phone', 'gen']) {
  test(`modo legado não muda a rede do Virtus: ${mode || 'sem proxy'}`, () => {
    const cfg = require('./serverConfig').buildNormalizedConfig({ proxyMode: mode, robe: { publishWithProxy: true } }, {});
    assert.equal(cfg.proxyMode, '');
    assert.equal(cfg.robe.publishWithProxy, true);
  });
}

for (const proxy of ['', 'http://synthetic-proxy:8080']) {
  test(`Chrome respeita a rota configurada: ${proxy ? 'proxy' : 'rede normal'}`, () => {
    const source = read('browser.js');
    const start = source.indexOf('function buildAccountChromeLaunchArgs(');
    const end = source.indexOf('function accountChromeLaunchConfig(', start);
    const build = vm.runInNewContext(source.slice(start, end) + '\nbuildAccountChromeLaunchArgs', {
      browserLanguageVoice: () => ({ navigatorLanguage: 'pt-BR' }), process: { env: {} }
    });
    const args = Array.from(build(proxy));
    assert.equal(args.some(arg => arg.startsWith('--proxy-server=')), !!proxy);
    if (proxy) assert.ok(args.includes('--proxy-server=' + proxy));
    assert.equal(args.includes('--no-proxy-server'), false);
  });
}

test('Virtus ignora flags antigas de proxy, mas o Robe isolado mantém seu túnel', () => {
  const source = read('browser.js');
  const start = source.indexOf('function buildAccountChromeLaunchArgs(');
  const end = source.indexOf('function accountChromeLaunchConfig(', start);
  const build = vm.runInNewContext(source.slice(start, end) + '\nbuildAccountChromeLaunchArgs', {
    browserLanguageVoice: () => ({ navigatorLanguage: 'pt-BR' }),
    process: { env: { CHROME_EXTRA_ARGS: '--proxy-server=http://old:80 --proxy-pac-url=http://old/pac --disable-gpu' } }
  });
  const direct = Array.from(build('', { directNetwork: true }));
  assert.ok(direct.includes('--no-proxy-server'));
  assert.equal(direct.some(arg => arg.startsWith('--proxy-')), false);
  const isolated = Array.from(build('127.0.0.1:12345'));
  assert.deepEqual(isolated.filter(arg => arg.startsWith('--proxy-')), ['--proxy-server=127.0.0.1:12345']);
  assert.ok(isolated.includes('--disable-gpu'));
});

for (const mode of ['cookies_first', 'password_first']) {
  test(`remediação respeita o modo ${mode} com credenciais disponíveis`, async () => {
    const source = read('worker.js');
    const start = source.indexOf('      // 4) Padrão: cookies primeiro.');
    const end = source.indexOf('      // 5) validar loginRequired', start);
    assert.ok(start > 0 && end > start);
    const calls = [];
    const result = await vm.runInNewContext('(async () => { ' + source.slice(start, end) + '; return sessionRestored; })()', {
      require: () => ({
        tryExistingPcSession: async () => { calls.push('cookies'); return { in: true }; },
        openFreshLoginPage: async () => {},
        attemptCredentialRelogin: async () => { calls.push('password'); return { ok: true }; }
      }),
      manifestStore: { read: async () => ({ login: 'synthetic-user', password: 'synthetic-pass' }) },
      ctrl: { trabalhando: false, browser: { pages: async () => [{}] } },
      authMode: mode, nome: 'test', pushStep: () => {}, beginCredentialAttempt: async () => true
    });
    assert.equal(result, true);
    assert.deepEqual(calls, [mode === 'cookies_first' ? 'cookies' : 'password']);
  });
}

for (const restored of [true, false]) {
  test(`cadastro: cookies ${restored ? 'válidos dispensam' : 'recusados acionam'} senha`, async () => {
    const source = read('browser.js');
    const start = source.indexOf("  const pcLogin = require('./pcSessionLogin.js');", source.indexOf('async function configureProfile('));
    const end = source.indexOf('  try {\n    provisionAudit.append', start);
    assert.ok(start > 0 && end > start);
    const calls = [];
    const result = await vm.runInNewContext('(async () => { ' + source.slice(start, end) + '; return sessionIn; })()', {
      require: () => ({
        tryExistingPcSession: async () => { calls.push('cookies'); return { in: restored }; },
        openFreshLoginPage: async () => {},
        attemptCredentialRelogin: async () => { calls.push('password'); return { ok: true }; }
      }),
      manifest: { login: 'synthetic-user', password: 'synthetic-pass' }, p0: {}, nome: 'test', dbg: false
    });
    assert.equal(result, true);
    assert.deepEqual(calls, restored ? ['cookies'] : ['cookies', 'password']);
  });
}
