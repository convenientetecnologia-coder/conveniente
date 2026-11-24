'use strict';const test=require('node:test'),assert=require('node:assert/strict'),guard=require('./interactionLease');
test('network mode is unchanged; every proxy flow requires its own healthy turn',()=>{
 guard.assert({browser:()=>({})});
 for(const flow of [
 {__ctCadastroProxy:{snapshot:()=>({healthy:false})}},
 {__ctIsolatedFlow:{proxyRequired:true,rail:{isProxyArmed:true,operationSnapshot:()=>({healthy:false})}}},
 {__ctVirtusProxy:{snapshot:()=>({state:'offline',operationId:'old'}),turn:{lease:{snapshot:()=>({healthy:true})}}}}
 ])assert.throws(()=>guard.assert({browser:()=>flow}),/interaction_without_healthy_proxy_turn/);
 guard.assert({browser:()=>({__ctIsolatedFlow:{proxyRequired:true,rail:{isProxyArmed:true,operationSnapshot:()=>({healthy:true})}}})});
 guard.assert({browser:()=>({__ctVirtusProxy:{snapshot:()=>({state:'online',operationId:'current'}),turn:{lease:{snapshot:()=>({healthy:true})}}}})});
});
test('control wait stops before DOM access when no chair exists',async()=>{
 const {waitControl,clickControl}=require('./interactionReadiness');let touches=0;
 const page={browser:()=>({__ctVirtusProxy:{snapshot:()=>({state:'offline'})}}),evaluateHandle:()=>{touches++;throw Error('must_not_touch')}};
 assert.match((await waitControl(page,['Continuar'])).reason,/interaction_without_healthy_proxy_turn/);
 assert.match((await clickControl(page,['Continuar'])).reason,/interaction_without_healthy_proxy_turn/);assert.equal(touches,0);
});
