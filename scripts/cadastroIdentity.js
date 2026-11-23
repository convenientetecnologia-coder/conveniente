'use strict';
function expected(manifest={}){
 const cookie=String((manifest.cookies||[]).find(c=>c?.name==='c_user')?.value||'').trim();
 const saved=String(manifest.expectedFacebookUserId||'').trim();
 if(/^\d+$/.test(saved)&&/^\d+$/.test(cookie)&&saved!==cookie)throw Error('cadastro_account_identity_mismatch');
 const login=String(manifest.login||manifest.user||manifest.username||'').trim();
 return [saved,cookie,login].find(v=>/^\d+$/.test(v))||'';
}
module.exports={expected};
