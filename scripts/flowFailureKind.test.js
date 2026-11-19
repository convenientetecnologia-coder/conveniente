'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const kinds = require('./flowFailureKind');

test('classificação distingue conectividade de erro DOM sem adivinhar timeout genérico', () => {
  for (const error of ['identity_proxy_unavailable', 'renew_proxy_transport_not_confirmed', 'phone_proxy_required:no_chair', 'net::ERR_TUNNEL_CONNECTION_FAILED']) assert.equal(kinds.isProxyFailure(error), true);
  for (const error of ['location_not_found', 'title_not_filled', 'renew_button_not_found', 'wizard_failed', 'Timeout exceeded']) assert.equal(kinds.isProxyFailure(error), false);
});

test('falha é persistida e sucesso limpa somente o alerta da própria etapa', async () => {
  let manifest = {};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'flowAlertFlags.js'), 'utf8'), {
    module, require: name => name === './manifestStore.js' ? { update: async (_n, patch) => { manifest = patch(manifest); } } : kinds
  });
  const api = module.exports;
  await api.setRobePostError('synthetic', { reason: 'location_not_found' });
  await api.setProxyPublishError('synthetic', { reason: 'proxy_mobile_unavailable' });
  await api.setRenewError('synthetic', { reason: 'renew_proxy_unavailable' });
  assert.equal(manifest.accountFlags.renewErrorReason, 'proxy:renew_proxy_unavailable');
  await api.clearProxyPublishError('synthetic');
  assert.equal(manifest.accountFlags.proxyPublishError, undefined);
  assert.equal(manifest.accountFlags.robePostError, true);
  assert.equal(manifest.accountFlags.renewError, true);
  await api.clearRobePostError('synthetic');
  await api.clearRenewError('synthetic');
  assert.equal(manifest.accountFlags, undefined);
});

test('resumo do servidor separa os mesmos tipos de erro enviados ao CT', () => {
  const { buildServerCardAggs } = require('./serverCardAgg');
  const result = buildServerCardAggs({ perfis: [
    { nome: 'a', marketplaceDocError: true, marketplaceDocErrorReason: 'proxy:identity_proxy_unavailable', proxyPublishError: true, renewError: true, renewErrorReason: 'proxy:renew_proxy_unavailable' },
    { nome: 'b', marketplaceDocError: true, marketplaceDocErrorReason: 'upload_input_not_found', robePostError: true, renewError: true, renewErrorReason: 'renew_button_not_found' }
  ] });
  for (const key of ['id_proxy_error', 'robe_proxy_error', 'renew_proxy_error', 'marketplace_doc_error', 'robe_post_error', 'renew_error']) assert.equal(result.flagsAgg[key], 1, key);
});

test('confirmação pelo proxy não abre aba de conferência e não declara aprovação pública', () => {
  const src = fs.readFileSync(path.join(__dirname, 'robe.js'), 'utf8');
  const start = src.indexOf('if (pubRes && pubRes.robeClosed === true)');
  const end = src.indexOf('      if (pubRes && pubRes.proxyRequired', start);
  const block = src.slice(start, end);
  assert.equal(block.includes('openAccountWorkPage'), false);
  assert.equal(block.includes('verifyOnSellerByTitle'), false);
  assert.ok(block.includes('approvalState: \'not_checked\''));
  assert.ok(block.includes('published = true'));
});

test('CT recompõe as mesmas contagens por etapa a partir do snapshot', { skip: !process.env.CT_SOURCE_ROOT }, () => {
  const source = fs.readFileSync(path.join(process.env.CT_SOURCE_ROOT, 'index.js'), 'utf8');
  const start = source.indexOf('    const flagsAgg = (() => {');
  const end = source.indexOf('})();', start) + 5;
  assert.ok(start > 0 && end > start);
  const result = vm.runInNewContext(source.slice(start, end) + '\nflagsAgg', {
    preferSnapshotRecompute: true, pollFlagsAgg: {}, fbAccountState: { classify: () => ({ kind: 'ok' }) },
    s: { status: { perfis: [
      { nome: 'a', marketplaceDocError: true, marketplaceDocErrorReason: 'proxy:identity_proxy_unavailable', proxyPublishError: true, renewError: true, renewErrorReason: 'proxy:renew_proxy_unavailable' },
      { nome: 'b', marketplaceDocError: true, marketplaceDocErrorReason: 'upload_input_not_found', robePostError: true, renewError: true, renewErrorReason: 'renew_button_not_found' }
    ] } }
  });
  for (const key of ['id_proxy_error', 'robe_proxy_error', 'renew_proxy_error', 'marketplace_doc_error', 'robe_post_error', 'renew_error']) assert.equal(result[key], 1, key);
});
