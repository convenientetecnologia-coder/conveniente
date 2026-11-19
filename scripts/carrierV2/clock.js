'use strict';
const {AsyncLocalStorage}=require('node:async_hooks'),scope=new AsyncLocalStorage();
function run(action){return scope.run({waitMs:0},action)}
function addWait(ms){const context=scope.getStore();if(context)context.waitMs+=Math.max(0,ms)}
function effective(deadline){return Number(deadline)+(scope.getStore()?.waitMs||0)}
module.exports={run,addWait,effective};
