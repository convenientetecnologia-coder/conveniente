'use strict';
// Chairs limit operations. A browser needs a separate TCP connection budget;
// this is a negotiated safety ceiling, not a limit on requests or file size.
const MAX_OPERATION_FLOWS = 64;
const MAX_FLOWS = 384;
function acceptedLimits(limits) {
  return !!limits && Number.isSafeInteger(limits.queueChunks) && limits.queueChunks >= 1 && limits.queueChunks <= 8 &&
    Number.isSafeInteger(limits.operationFlows) && limits.operationFlows >= 1 && limits.operationFlows <= MAX_OPERATION_FLOWS &&
    Number.isSafeInteger(limits.maxFlows) && limits.maxFlows >= limits.operationFlows && limits.maxFlows <= MAX_FLOWS;
}
module.exports = { acceptedLimits, MAX_OPERATION_FLOWS, MAX_FLOWS };
