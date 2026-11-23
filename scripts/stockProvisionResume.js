'use strict';
// Repair missing authentication material only; preserve an existing valid session.
async function restoreMissingCookies({profileName,manifest,cookies,httpJson}){
 const normalized=require('./utils').normalizeCookies(cookies);
 const identity=list=>String((list||[]).find(c=>c?.name==='c_user')?.value||'').trim();
 const expected=identity(normalized),current=identity(manifest.cookies);
 if(!/^\d+$/.test(expected)||!normalized.some(c=>c.name==='xs'&&c.value))throw Error('resume_source_cookies_invalid');
 if(/^\d+$/.test(current)&&current!==expected)throw Error('resume_cookie_identity_mismatch');
 if(current===expected&&(manifest.cookies||[]).some(c=>c?.name==='xs'&&c.value))return {restored:false};
 const result=await httpJson(`/api/perfis/${encodeURIComponent(profileName)}/stock-update`,{method:'POST',headers:{'x-operator':'stock_push'},body:{cookies:normalized,applyCookies:0}});
 if(!result||result.ok===false)throw Error('resume_cookie_restore_failed');
 return {restored:true};
}
module.exports={restoreMissingCookies};
