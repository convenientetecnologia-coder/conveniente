'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPublishRequest, acceptExit, isPublishMarked } = require('./mobilePublishProxy.js');

test('AS22085 no Brasil entra, outra rede nao entra', () => {
  assert.equal(acceptExit({ asn: 'AS22085', country: 'BR' }), true);
  assert.equal(acceptExit({ asn: 'AS28573', country: 'BR' }), false);
  assert.equal(acceptExit({ asn: 'AS22085', country: 'US' }), false);
  assert.equal(acceptExit({ asn: '', country: 'BR' }), false);
});

test('mutacao de anuncio vai no proxy e consulta fica no wifi', () => {
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation&variables=%7B%7D'
  }), 'proxy');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=useMarketplaceComposerMedianPackageDetailQuery&doc_id=1'
  }), 'wifi');
  assert.equal(classifyPublishRequest({
    method: 'GET',
    url: 'https://www.facebook.com/marketplace/you/selling',
    postData: ''
  }), 'ignore');
});

test('pedido de publicar sem nome conhecido vai no proxy, leitura do you selling fica no wifi', () => {
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'doc_id=999&variables=%7B%22foo%22%3A1%7D'
  }), 'proxy');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=MarketplaceYouSellingQuery&doc_id=1'
  }), 'wifi');
  assert.equal(isPublishMarked({
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation'
  }), true);
  assert.equal(isPublishMarked({
    postData: 'doc_id=999&variables=%7B%22foo%22%3A1%7D'
  }), false);
});
