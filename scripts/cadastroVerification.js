'use strict';
async function verify({browser,cookies,expectedUserId,detectLoginRequired=require('./browser').detectLoginRequired}){
 browser.__ctCadastroProxy?.assertHealthy();
 const expected=String(expectedUserId||(cookies||[]).find(c=>c?.name==='c_user')?.value||'').trim();
 if(!/^\d+$/.test(expected))throw Error('cadastro_expected_identity_missing');
 const pages=await browser.pages();
 const page=pages.find(p=>{try{const u=new URL(p.url());return /(^|\.)facebook\.com$/.test(u.hostname)&&/^\/messages(?:\/|$)/.test(u.pathname)}catch{return false}});
 if(!page)throw Error('cadastro_messages_page_missing');
 if(typeof page.waitForFunction==='function')await page.waitForFunction(()=>{
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>2&&r.height>2};
  return document.readyState==='complete'&&Array.from(document.querySelectorAll('h1,[role="heading"]')).some(e=>visible(e)&&/^(Conversas|Chats|Marketplace|Messenger)$/i.test(String(e.innerText||e.textContent||'').trim()));
 },{timeout:120000}).catch(()=>{throw Error('cadastro_ui_ready_timeout')});
 const health=await detectLoginRequired(page);
 if(!health||health.loginRequired!==false)throw Error('cadastro_login_unconfirmed:'+String(health?.reason||'probe_failed'));
 const stored=await page.cookies('https://www.facebook.com');
 if(String(stored.find(c=>c.name==='c_user')?.value||'')!==expected)throw Error('cadastro_account_identity_mismatch');
 const ui=await page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>2&&r.height>2};
  const headings=[...document.querySelectorAll('h1,[role="heading"]')].filter(visible).map(e=>String(e.innerText||e.textContent||'').trim());
  const login=!!document.querySelector('input[name="pass"],form#login_form');
  const loaded=document.readyState==='complete'&&headings.some(t=>/^(Conversas|Chats|Marketplace|Messenger)$/i.test(t));
  const blocking=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible).some(d=>/captcha|confirmar.*identidade|insira seu pin|enter your pin/i.test(d.innerText||''));
  return {loaded,login,blocking};
 });
 if(!ui.loaded||ui.login||ui.blocking)throw Error('cadastro_ui_not_verified');
 browser.__ctCadastroProxy?.assertHealthy();
 return {ok:true,identityMatched:true,messagesReady:true};
}
module.exports={verify};
