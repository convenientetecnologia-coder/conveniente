'use strict';
// Resource policy only. Closing a browser never deletes the account or its data.
function reason(flags={}){
 const kinds={banned:true,captcha:true,two_factor:true,marketplace_disabled:true,id_virtus:true,selfie_video:true,account_code:true};
 const result=require('./dailyTerminalCleanup').classifyTerminalDelete(flags,{deleteKinds:kinds});
 return result.delete?result.category:null;
}
module.exports={reason};
