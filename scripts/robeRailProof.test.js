'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),net=require('node:net'),https=require('node:https');
const {once}=require('node:events');
const source=fs.readFileSync(require('node:path').join(__dirname,'robeRail.js'),'utf8');
const start=source.indexOf('function proveThroughRail('),end=source.indexOf('function isAccountCookieDomain(',start);
const prove=vm.runInNewContext(source.slice(start,end)+'\nproveThroughRail',{
 net,https,Buffer,setTimeout,clearTimeout,
 // O servidor de teste fala HTTP dentro do túnel, sem exigir certificado TLS.
 tls:{connect:({socket})=>{queueMicrotask(()=>socket.emit('secureConnect'));return socket}}
});
async function fixture(response,action){
 const sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let phase=0,buffer='';
  socket.on('data',data=>{buffer+=data.toString();if(!buffer.includes('\r\n\r\n'))return;
   buffer='';if(phase++===0)socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');else socket.write(response);
  });
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{await action(server.address().port)}finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))}
}
test('prova lê JSON chunked completo sem esperar encerramento do túnel',async()=>{
 const json='{"ip":"191.1.2.3","providers":{"maxmind":{"asn":"AS22085"}}}';
 const a=json.slice(0,25),b=json.slice(25);
 const response='HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+a.length.toString(16)+'\r\n'+a+'\r\n'+b.length.toString(16)+'\r\n'+b+'\r\n0\r\n\r\n';
 await fixture(response,async port=>{const raw=await prove(port);assert.equal(JSON.parse(raw).ip,'191.1.2.3')});
});
test('prova respeita Content-Length sem precisar de FIN TCP',async()=>{
 const json='{"ip":"191.1.2.3"}';await fixture('HTTP/1.1 200 OK\r\nContent-Length: '+json.length+'\r\n\r\n'+json,async port=>assert.equal(await prove(port),json));
});
test('HTTP de erro é identificado e não vira falha de rede móvel',async()=>{
 await fixture('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}',async port=>assert.rejects(prove(port),/prove_http_status:429/));
});
