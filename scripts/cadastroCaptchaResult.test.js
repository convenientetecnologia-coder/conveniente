'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('cadastro result commits confirmed captcha before login recording and publishes the same blocked state', async () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, 'worker.js'), 'utf8');
  const start = source.indexOf('async function finishAccountProvisioningResult(');
  const end = source.indexOf('async function prepareCadastroBrowser', start);
  for (const error of ['captcha_checkpoint', 'captcha_after_cookie_continue_password', 'login_post_submit_timeout']) {
    const calls = [];
    const run = vm.runInNewContext('('+source.slice(start,end)+')', {
      setCaptchaCheckpointFlag: async (nome, opts) => calls.push(['captcha', opts.confirmedPostPassword]),
      recordLoginFlow: async () => calls.push(['login']),
      require: () => ({settle: async () => calls.push(['settle'])}),
      fileStore: {}, provisionAudit: {}, readJsonFile: () => ({}), desiredPath: '',
      clearIdentityFlags: async () => {}
    });
    await run('fixture', {ok:false,error});
    assert.deepEqual(calls, error.startsWith('captcha') ? [['captcha',true],['login'],['settle']] : [['login'],['settle']]);
  }
});
