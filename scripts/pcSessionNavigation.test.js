'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{isTransient}=require('./stockProvisionRetry');
const source=fs.readFileSync(require.resolve('./pcSessionLogin'),'utf8');
test('falha ao carregar sessão preserva distinção entre rede e cookie rejeitado',async()=>{
 const start=source.indexOf('async function tryExistingPcSession('),end=source.indexOf('\nasync function collectFreshCookies',start);let inspected=false;
 const fn=vm.runInNewContext('('+source.slice(start,end)+')',{manifestStore:{read:async()=>({cookies:[{name:'fixture'}]})},cookiesHaveSession:()=>true,HOME_URL:'https://www.facebook.com/',placeCookies:async()=>{},sleep:async()=>{},feedOpened:async()=>{inspected=true;return false},Error,String});
 await assert.rejects(fn({goto:async()=>{throw Error('net::ERR_PROXY_CONNECTION_FAILED')}},'account'),e=>{assert.equal(isTransient(e.message),true);return /pc_login_navigation_failed/.test(e.message)});assert.equal(inspected,false);
});
test('login não começa a digitar em uma navegação que falhou',async()=>{
 const start=source.indexOf('async function openFreshLoginPage('),end=source.indexOf('\nasync function loginFormStillVisible',start);let slept=false;
 const fn=vm.runInNewContext('('+source.slice(start,end)+')',{prepareFreshLogin:async()=>{},LOGIN_URL:'https://mbasic.facebook.com/login/',sleep:async()=>{slept=true},Error,String});
 await assert.rejects(fn({goto:async()=>{throw Error('timeout')}},'account'),/pc_login_navigation_failed/);assert.equal(slept,false);
});
