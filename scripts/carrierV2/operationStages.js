'use strict';
function begin(row,stage,now=Date.now()){
 if(!['identity','renew','virtus'].includes(stage)||row.type!=='publish')throw Error('cp2_invalid_account_stage');
 if(row.pendingStage===stage)return false;
 if(row.pendingStage)throw Error('cp2_previous_stage_unconfirmed');
 row.stageResults=row.stageResults||{};
 if(row.result==='confirmed'&&!row.stageResults.publish)row.stageResults.publish={state:'confirmed',at:now};
 row.pendingStage=stage;row.stageResults[stage]={state:'unknown',at:now};row.result='unknown';return true;
}
function confirm(row,now=Date.now(),observedStage){
 if(observedStage&&row.pendingStage&&observedStage!==row.pendingStage)throw Error('cp2_stage_confirmation_mismatch');
 row.stageResults=row.stageResults||{};const stage=row.pendingStage||observedStage||row.type;
 row.stageResults[stage]={state:'confirmed',at:now};delete row.pendingStage;row.result='confirmed';
}
module.exports={begin,confirm};
