'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readExit } = require('./robeRail.js');
const { acceptExit } = require('./mobilePublishProxy.js');

test('a prova da aba le o ASN que o proxy devolve', () => {
  const seen = readExit({
    ip: '179.1.2.3',
    providers: { maxmind: { asn: 'AS22085', country: 'BR' } }
  });
  assert.equal(seen.ip, '179.1.2.3');
  assert.equal(acceptExit(seen), true);
  assert.equal(acceptExit(readExit({ ip: '1.2.3.4', providers: { maxmind: { asn: 'AS28573', country: 'BR' } } })), false);
  assert.equal(readExit(null).asn, '');
});
