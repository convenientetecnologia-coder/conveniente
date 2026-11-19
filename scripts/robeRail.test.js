'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readExit } = require('./robeRail.js');
const { acceptExit } = require('./mobilePublishProxy.js');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { createDirectSwitch } = require('./robeRail.js');

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

test('comutador isola rede direta e mede envio/recepção, inclusive dados junto ao CONNECT', async () => {
  const direct = net.createServer(socket => socket.on('data', data => socket.write('DIRECT:' + data.toString())));
  direct.listen(0, '127.0.0.1'); await once(direct, 'listening');
  const proxy = http.createServer();
  let proxySocket;
  proxy.on('connect', (_req, socket) => {
    proxySocket = socket;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\nGREETING:');
    socket.on('data', data => socket.write('ECHO:' + data.toString()));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const sw = createDirectSwitch();
  const port = await sw.listen();
  async function exchange(payload, expected) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      const timer = setTimeout(() => { socket.destroy(); reject(Error('test timeout')); }, 5000);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${direct.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n${payload}`));
      socket.on('data', data => {
        received += data;
        if (received.includes(expected)) { clearTimeout(timer); socket.destroy(); resolve(received); }
      });
    });
  }
  try {
    await exchange('PREPARE', 'DIRECT:PREPARE');
    assert.equal(sw.trafficSnapshot().directUp, 7);
    assert.equal(sw.trafficSnapshot().proxyUp, 0);
    sw.flip({ host: '127.0.0.1', port: proxy.address().port, user: 'synthetic', pass: 'synthetic' });
    const received = await exchange('PUBLISH', 'ECHO:PUBLISH');
    assert.ok(received.includes('GREETING:'));
    const meter = sw.trafficSnapshot();
    assert.equal(sw.bytesToProxy(), 7);
    assert.equal(meter.proxyUp, proxySocket.bytesRead);
    assert.equal(meter.proxyDown, proxySocket.bytesWritten);
    assert.equal(meter.directUp, 7);
    sw.flip(null);
    await exchange('AFTER', 'DIRECT:AFTER');
    assert.equal(sw.trafficSnapshot().proxyUp, meter.proxyUp);
  } finally {
    await sw.close();
    if (proxySocket) proxySocket.destroy();
    await Promise.all([new Promise(resolve => direct.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  }
});
