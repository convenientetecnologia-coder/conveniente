'use strict';
async function invoke({ctrl,read,update,guard,overlay,snapshot,onReady=async()=>{},onError=()=>{}}){
 const proxy=ctrl.browser.__ctVirtusProxy;
 if(!ctrl._proxyHumanPrevious){const want=read()||{};ctrl._proxyHumanPrevious={active:want.active,virtus:want.virtus,trabalhando:ctrl.trabalhando};}
 ctrl.humanControl=true;ctrl.trabalhando=false;
 // The connection request runs independently of the local administrative panel.
 proxy.enterHuman().then(()=>{if(ctrl.humanControl)return onReady()}).catch(error=>{if(error.message!=='virtus_human_canceled')onError(error)});
 await update(want=>({...want,humanHold:true,virtus:'off'}));
 await guard(true);const panel=await overlay();await snapshot();
 return {ok:panel?.panelReady===true,state:proxy.snapshot().state==='online'?'human_online':'human_waiting_proxy',panelReady:panel?.panelReady===true,...(panel?.panelReady===true?{}:{error:'human_panel_unconfirmed'})};
}
async function resume({ctrl,read,update,guard,overlay,snapshot,validate}){
 const proxy=ctrl.browser.__ctVirtusProxy;
 if(typeof validate!=='function')return {ok:false,state:'resume_unconfirmed',error:'human_resume_validation_required'};
 ctrl._proxyHumanResuming=true;
 try{
 const checked=await proxy.resumeHuman(async lease=>{await guard(false);return validate(lease)});
 if(checked?.ok!==true)throw Error(checked?.error||'human_resume_inbox_unconfirmed');
 const previous=ctrl._proxyHumanPrevious||read()||{};
 ctrl.humanControl=false;ctrl.trabalhando=false;
 await update(want=>({...want,active:previous.active===undefined?want.active:previous.active,virtus:previous.virtus||'on',humanHold:false}));
 delete ctrl._proxyHumanPrevious;
 await guard(false);await overlay({hide:true});await snapshot();
 return {ok:true,state:'automation_resumed',inboxVerified:true,recheckQueued:true};
 }catch(error){ctrl.humanControl=true;ctrl.trabalhando=false;await update(want=>({...want,humanHold:true,virtus:'off'}));await guard(true);await overlay({hide:false});await snapshot();return {ok:false,state:'resume_failed',error:String(error.message||error)}}
 finally{ctrl._proxyHumanResuming=false;}
}
module.exports={invoke,resume};
