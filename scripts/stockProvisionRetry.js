'use strict';
function isTransient(error) {
 const value=String(error||'');
 if(/identity_required|checkpoint|captcha|still_login_required|login_form|login_wall|invalid.cookie|unauthorized|forbidden|two_factor|whatsapp_confirm/i.test(value))return false;
 return /carrier_unavailable|cp2_transport|cp2_connect|phone_proxy_required|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\btimeout\b|cadastro_ui_ready_timeout|provision_lock_busy|supervisor_unreachable/i.test(value);
}
function retryPlan(record, output, now=Date.now()) {
 const row=output?.results?.find(r=>r?.type==='stock_provision');
 const actions=row?.details?.results;
 const original=Array.isArray(record?.payload?.actions)?record.payload.actions:[];
 let retry;
 if(Array.isArray(actions)&&actions.length){
  const ids=new Set(actions.filter(a=>a?.ok!==true&&isTransient(a?.error||row?.error)).map(a=>Number(a.stockAccountId)));
  retry=original.filter(a=>ids.has(Number(a.stockAccountId||a.stock_account_id)));
 } else retry=isTransient(row?.error)?original:[];
 if(!retry.length)return null;
 const retryCount=Math.min(1000000,Math.max(0,Number(record.retryCount)||0)+1);
 const delay=Math.min(300000,30000*2**Math.min(4,retryCount-1));
 return {...record,payload:{...record.payload,actions:retry},stockAccountIds:retry.map(a=>Number(a.stockAccountId||a.stock_account_id)),retryCount,nextAttemptAt:now+delay};
}
module.exports={isTransient,retryPlan};
