'use strict';
// A local timeout cannot extend the authority's connection deadline.
function timeout(page,requestedMs,now=Date.now()){
 const browser=page?.browser?.(),flow=browser?.__ctIsolatedFlow;
 const state=flow?.rail?.operationSnapshot?.()||browser?.__ctVirtusProxy?.turn?.lease?.snapshot?.();
 const hard=state?.absoluteDeadline?state.absoluteDeadline*1000-3000:Infinity;
 return Math.max(0,Math.min(Math.max(0,Number(requestedMs)||0),hard-now,flow?.deadlineAt?flow.deadlineAt-now:Infinity));
}
module.exports={timeout};
