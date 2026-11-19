'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const serverId='11111111-1111-1111-1111-111111111111';
const config={enabled:true,baseUrl:'https://api.convenientetecnologia.com/api/carrier-v2',serverId,eligiblePhoneIds:['p001','p003']};
function fixture(data){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'bootstrapClient.js'),'utf8'),{module,require:id=>{assert.equal(id,'../ctConfig');return {readCtConfig:()=>({carrierV2:data})}},fetch:()=>{throw Error('unexpected_network')}});return module.exports}
test('recebe configuração CT sem segredo, token ou bootstrap de rede',async()=>{const c=await fixture({...config,token:'ignored-old-value'}).read();assert.equal(c.serverId,serverId);assert.equal(c.token,undefined);assert.deepEqual(Array.from(c.eligiblePhoneIds),['p001','p003'])});
test('configuração ausente, revogada e inválida têm erros distintos',async()=>{await assert.rejects(fixture(null).read(),/waiting_ct_configuration/);await assert.rejects(fixture({enabled:false}).read(),/server_not_assigned/);for(const patch of [{serverId:''},{baseUrl:'http://elsewhere'},{eligiblePhoneIds:['p999']}])await assert.rejects(fixture({...config,...patch}).read(),/ct_configuration_invalid/)});
