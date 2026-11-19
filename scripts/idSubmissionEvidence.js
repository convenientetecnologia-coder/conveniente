'use strict';
function classify({text='',controls=[]}={}){
 const n=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const labels=controls.map(x=>String(x).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim());
 const actionable=labels.some(x=>/^(?:confirme? (?:sua )?identidade|confirmar identidade|verificar identidade|verify your identity|confirm your identity|avancar|continuar|next|continue|enviar|submit|send|carregar documento.*|upload identity document)$/.test(x));
 if(actionable)return {confirmed:false,reason:'identity_action_still_available'};
 const classic=/(?:suas informacoes (?:foram|ja foram) enviadas|your information (?:was|has been) submitted|enviamos suas informacoes)/.test(n);
 const pending=/(?:confirmacao|verificacao|analise) (?:da |de )?identidade (?:esta )?em andamento|(?:estamos analisando|recebemos) (?:o seu|seu|o) documento de identidade|identity verification (?:is )?(?:in progress|under review)|your identity (?:is )?under review/.test(n);
 return {confirmed:classic||pending,kind:classic?'submitted':pending?'pending':null,reason:classic||pending?'explicit_identity_submission':'no_explicit_identity_submission'};
}
async function read(page){
 const samples=await page.evaluate(()=>{
  const visible=el=>!!(el.getBoundingClientRect().width&&el.getBoundingClientRect().height)&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
  const dialogs=Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible);
  // Never combine unrelated listing/feed text with identity status. A whole
  // page is eligible only on the dedicated identity checkpoint itself.
  const roots=dialogs.length?dialogs:(/\/checkpoint\//.test(location.pathname)?[document.body]:[]);
  return roots.filter(Boolean).map(root=>({text:String(root.innerText||'').slice(0,10000),controls:Array.from(root.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(visible).map(el=>el.getAttribute('aria-label')||el.innerText||el.value||'')}));
 });
 const checked=samples.map(sample=>({...classify(sample),sample}));
 const blocked=checked.find(x=>x.reason==='identity_action_still_available');
 return blocked||checked.find(x=>x.confirmed)||{confirmed:false,reason:'no_scoped_identity_submission'};
}
module.exports={classify,read};
