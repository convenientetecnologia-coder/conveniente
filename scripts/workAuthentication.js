'use strict';
async function assertAuthenticated(page,nome,{detect=require('./browser').detectLoginRequired,persist=require('./manifestStore').update}={}){
 const login=await detect(page);
 if(login?.loginRequired===true){
  await persist(nome,man=>require('./proxyHealthFlags').record(man,{state:'login',reason:login.reason||'login_required'}));
  throw Error('still_login_required:'+(login.reason||'login_required'));
 }
}
module.exports={assertAuthenticated};
