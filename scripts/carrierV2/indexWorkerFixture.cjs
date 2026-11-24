'use strict';
const net=require('node:net'),{once}=require('node:events'),client=require('./indexClient');
process.on('message',async message=>{if(message.type==='proxy_ready'){const ready=await client.ready(message.payload.ticket);process.send({replyTo:message.msgId,data:{ok:true,ready}})}});
(async()=>{
 const lease=await client.begin({nome:'fixture-account',purpose:'virtus',intent:'reply',isReady:async()=>true});
 const socket=net.connect(lease.hop.port,'127.0.0.1');await once(socket,'connect');
 const payload='worker executes only on Index assigned route';const received=new Promise((resolve,reject)=>{let output='';socket.on('error',reject);socket.on('data',b=>{output+=b;if(output.length>=payload.length)resolve(output)})});socket.write(payload);
 if(await received!==payload)throw Error('route payload mismatch');socket.destroy();
 await lease.possibleSideEffect();await lease.confirm();await lease.close();
 process.send({fixtureDone:true,operationId:lease.operationId});process.disconnect();
})().catch(error=>{process.send?.({fixtureError:error.message});process.exitCode=1;process.disconnect()});
