'use strict';
const MAX_COMMAND_AGE_MS=7*24*60*60*1000;
const RECEIPT_RETENTION_MS=8*24*60*60*1000;
const CLOCK_ALLOWANCE_MS=5*60*1000;
function reject(code){const error=Error(code);error.deliveryCommandRejected=true;return error}
function issuedAtOf(record={}){
 const explicit=record.issued_at??record.issuedAt;
 const id=String(record.client_message_id||record.id||'');
 const legacy=/^md_ia_delta:\d+:(\d{13,16})$/.exec(id);
 const legacyAt=legacy?Number(legacy[1]):null;
 const validLegacy=Number.isSafeInteger(legacyAt)&&legacyAt>0?legacyAt:null;
 if(explicit!==undefined&&explicit!==null){const at=Number(explicit);return Number.isSafeInteger(at)&&at>0?(validLegacy===null?at:Math.min(at,validLegacy)):null}
 return validLegacy;
}
function assertNewCommand(record,{now=Date.now()}={}){
 if(!Number.isFinite(now))throw reject('delivery_command_clock_invalid');
 const explicit=record?.issued_at??record?.issuedAt;
 const issuedAt=issuedAtOf(record);
 if(explicit!==undefined&&explicit!==null&&issuedAt===null)throw reject('delivery_command_issued_at_invalid');
 if(explicit!==undefined&&explicit!==null&&Number(explicit)>now+CLOCK_ALLOWANCE_MS)throw reject('delivery_command_issued_at_invalid');
 if(issuedAt!==null&&issuedAt>now+CLOCK_ALLOWANCE_MS)throw reject('delivery_command_issued_at_invalid');
 if(issuedAt!==null&&now-issuedAt>MAX_COMMAND_AGE_MS)throw reject('delivery_command_expired');
 return issuedAt;
}
module.exports={issuedAtOf,assertNewCommand,MAX_COMMAND_AGE_MS,RECEIPT_RETENTION_MS,CLOCK_ALLOWANCE_MS};
