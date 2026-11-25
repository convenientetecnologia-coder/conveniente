'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{timeout}=require('./interactionBudget');
test('network mode keeps its configured timeout',()=>assert.equal(timeout({browser:()=>({})},120000,1000),120000));
test('isolated flow and human chair never wait past the real connection deadline',()=>{
 const rail={operationSnapshot:()=>({absoluteDeadline:100})};
 assert.equal(timeout({browser:()=>({__ctIsolatedFlow:{rail,deadlineAt:80000}})},120000,1000),79000);
 assert.equal(timeout({browser:()=>({__ctVirtusProxy:{turn:{lease:{snapshot:()=>({absoluteDeadline:100})}}}})},120000,1000),96000);
 assert.equal(timeout({browser:()=>({__ctIsolatedFlow:{rail}})},120000,100000),0);
});
