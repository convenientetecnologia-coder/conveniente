'use strict';
function record(man,health,now=Date.now()){
 man=man||{};const flags=man.accountFlags=man.accountFlags||{};
 const field={pin:'messengerPin',captcha:'captchaCheckpoint',identity:'idVirtus',login:'loginRequired',banned:'banned'}[health.state];
 if(!field)return man;
 const prefix=health.state==='login'?'login':field;
 flags[field]=true;flags[prefix+'Reason']=health.reason||health.state;flags[prefix+'Source']='virtus_proxy_turn';flags[prefix+'At']=now;
 man.proxyHealth={state:health.state,reason:health.reason,at:now};return man;
}
function loginReason(flags={}){return flags.loginReason||flags.loginRequiredReason||'';}
module.exports={record,loginReason};
