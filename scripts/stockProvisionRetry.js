'use strict';
function isTransient(error) {
 const value=String(error||'');
 if(/^(?:cookie_session_unconfirmed|still_login_required:messenger_page_not_available)$/.test(value))return true;
 if(/^(?:kill_guard_until|login_surface_not_ready|login_transport_not_ready|login_continue_not_ready|login_input_not_ready|login_input_fill_unconfirmed|login_submit_not_ready|login_ui_error|login_result_unconfirmed)$/.test(value))return true;
 if(/^interaction_without_healthy_proxy_turn(?::|$)|^(?:mobile_transport_not_healthy|virtus_transport_unhealthy|virtus_transport_lost_during_turn)$/.test(value))return true;
  if(/^(?:proxy_index_unavailable|proxy_index_queue_full|proxy_job_not_found|proxy_worker_unavailable|proxy_job_canceled|proxy_index_job_canceled)$/.test(value))return true;
 if(/^(?:pin_input_changed_before_typing|pin_input_focus_or_value_changed|pin_input_not_found|messenger_pin_probe_failed|login_surface_probe_failed)$/.test(value))return true;
 if(value==='account_security:security_step_unconfirmed'||value==='fetch failed')return true;
 if(/^(maintenance|carrier_maintenance|operation_control_in_flight|carrier_ack_timeout)$/.test(value))return true;
 if(value.startsWith('pc_login_navigation_failed:'))return true;
 if(/^(?:login_form_not_found|login_result_missing|login_submit_failed|session_not_saved)$/.test(value))return true;
 if(/cadastro_proxy_transport_(?:unhealthy|lost)|cadastro_expected_identity_missing|cadastro_messages_page_missing|cadastro_session_save_unconfirmed|cadastro_ui_not_verified|detached Frame|Target closed|Session closed|Execution context was destroyed|Navigation timeout|Protocol error|net::ERR_(?:INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_RESET|TIMED_OUT)/i.test(value))return true;
 if(/identity_required|checkpoint|captcha|still_login_required|login_form|login_wall|invalid.cookie|unauthorized|forbidden|two_factor|whatsapp_confirm/i.test(value))return false;
 return /carrier_unavailable|cp2_transport|cp2_connect|cp2_uncertain_transport_not_closed|cp2_previous_operation_not_closed|phone_proxy_required|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\btimeout\b|cadastro_ui_ready_timeout|provision_lock_busy|supervisor_unreachable|already_opening|worker off|supervisor_denied:(?:cooldown|slots|ram_low)|HTTP\/\d(?:\.\d)?\s+50[234]\b|\b50[234]\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(value);
}
function retryPlan(record, output, now=Date.now()) {
 const row=output?.results?.find(r=>r?.type==='stock_provision');
 const actions=row?.details?.results;
 const original=Array.isArray(record?.payload?.actions)?record.payload.actions:[];
 let retry;
 const queueOwns=a=>!!(a&&a.profileName)&&!require('./accountProvisioningState').restriction(a.error||row?.error);
 if(Array.isArray(actions)&&actions.length){
  const ids=new Set(actions.filter(a=>a?.ok!==true&&isTransient(a?.error||row?.error)&&!queueOwns(a)).map(a=>Number(a.stockAccountId)));
  retry=original.filter(a=>ids.has(Number(a.stockAccountId||a.stock_account_id)));
 } else retry=isTransient(row?.error)&&!queueOwns(row)?original:[];
 if(!retry.length)return null;
 const retryCount=Math.min(1000000,Math.max(0,Number(record.retryCount)||0)+1);
 const delay=Math.min(300000,30000*2**Math.min(4,retryCount-1));
 return {...record,payload:{...record.payload,actions:retry},stockAccountIds:retry.map(a=>Number(a.stockAccountId||a.stock_account_id)),retryCount,nextAttemptAt:now+delay};
}
module.exports={isTransient,retryPlan};
