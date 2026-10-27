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

test('da foto ate o publicar o facebook vai no proxy, e depois volta pro wifi', () => {
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://upload.facebook.com/ajax/react_composer/attachments/photo/upload',
    postData: 'foto'
  }), 'proxy');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation&variables=%7B%7D'
  }), 'proxy');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=MarketplaceYouSellingQuery&doc_id=1',
    publishCaptured: true
  }), 'wifi');
  assert.equal(classifyPublishRequest({
    method: 'GET',
    url: 'https://www.facebook.com/marketplace/you/selling',
    postData: ''
  }), 'wifi');
  assert.equal(isPublishMarked({
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation'
  }), true);
});
