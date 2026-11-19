'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { watch, summarizeResponse } = require('./robePublishEvidence');
const { readSellerListingState } = require('./robePublishEvidence');

function request(op = 'CometMarketplaceListingCreateMutation') {
  return { url: () => 'https://www.facebook.com/api/graphql/', method: () => 'POST', headers: () => ({}), postData: () => 'fb_api_req_friendly_name=' + op };
}
test('somente a resposta concluída de criação após o clique comprova transporte', () => {
  const page = new EventEmitter(), observer = watch(page), req = request();
  page.emit('request', req);
  assert.equal(observer.snapshot().seen, false);
  observer.arm();
  page.emit('request', request('OtherQuery'));
  assert.equal(observer.snapshot().seen, false);
  page.emit('request', req);
  page.emit('response', { request: () => req, status: () => 200 });
  assert.equal(observer.snapshot().transportOk, false);
  page.emit('requestfinished', req);
  assert.equal(observer.snapshot().transportOk, true);
  observer.cleanup();
  for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(page.listenerCount(event), 0);
});

test('HTTP 200 só confirma criação quando a resposta traz o ID do anúncio sem erro', async () => {
  const page = new EventEmitter(), observer = watch(page), req = request();
  observer.arm(); page.emit('request', req);
  page.emit('response', { request: () => req, status: () => 200, text: async () => JSON.stringify({ data: { marketplace_listing_create: { marketplace_listing: { id: '12345678901' } } } }) });
  page.emit('requestfinished', req);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.snapshot().creationConfirmed, true);
  assert.deepEqual(observer.snapshot().listingIds, ['12345678901']);
  observer.cleanup();
  assert.equal(summarizeResponse('{"data":null,"errors":[{"message":"synthetic"}]}').hasErrors, true);
  assert.deepEqual(summarizeResponse('{"data":{"viewer":{"id":"99999999999"}}}').listingIds, []);
});

test('status de uma requisição não completa a confirmação de outra', () => {
  const page = new EventEmitter(), observer = watch(page), a = request(), b = request();
  observer.arm(); page.emit('request', a); page.emit('request', b);
  page.emit('response', { request: () => a, status: () => 500 });
  page.emit('requestfinished', a);
  page.emit('response', { request: () => b, status: () => 200 });
  assert.equal(observer.snapshot().transportOk, false);
  observer.cleanup();
});

test('renovação exige mutation de renovação concluída, sem erro e com dados', async () => {
  for (const response of [
    { data: { marketplace_listing_renew: { success: true } } },
    { data: { marketplace_listing_renew: { success: false } } },
    { data: { marketplace_listing_renew: null } },
    { data: { marketplace_listing_renew: { success: true } }, errors: [{ message: 'synthetic' }] }
  ]) {
    const page = new EventEmitter(), observer = watch(page, { operation: 'renew' });
    const req = request('MarketplaceListingRenewMutation');
    observer.arm(); page.emit('request', req);
    page.emit('response', { request: () => req, status: () => 200, text: async () => JSON.stringify(response) });
    page.emit('requestfinished', req);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observer.snapshot().operationConfirmed, response.data.marketplace_listing_renew?.success === true && !response.errors);
    observer.cleanup();
  }
});

test('listagem diferencia anúncio ativo de duplicado, recusado ou pendente mesmo com is_live=true', async () => {
  for (const flags of [{}, { is_duplicate: true }, { listing_is_rejected: true }, { is_pending: true }, { listing_status_indicator: { content: 'Esse classificado está sendo analisado.' } }]) {
    const listing = { id: '12345678901', is_viewer_seller: true, is_live: true, ...flags };
    const page = { evaluate: async (fn, id) => vm.runInNewContext('(' + fn.toString() + ')(' + JSON.stringify(id) + ')', {
      location: { pathname: '/marketplace/you/selling' },
      document: { scripts: [{ textContent: JSON.stringify({ data: { viewer: { inactive_listing_sets: { first_listing: listing } } } }) }] }
    }) };
    const result = await readSellerListingState(page, '12345678901');
    assert.equal(result.found, true);
    assert.equal(result.active, Object.keys(flags).length === 0);
  }
});
test('falha de rede ou HTTP de erro não comprova transporte', () => {
  for (const fail of [true, false]) {
    const page = new EventEmitter(), observer = watch(page), req = request();
    observer.arm(); page.emit('request', req);
    page.emit('response', { request: () => req, status: () => fail ? 200 : 500 });
    page.emit(fail ? 'requestfailed' : 'requestfinished', req);
    assert.equal(observer.snapshot().transportOk, false);
    observer.cleanup();
  }
});
