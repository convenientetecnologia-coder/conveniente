'use strict';
const numeric=value=>/^\d+$/.test(String(value||''));
function expected(manifest={}){
 const cookie=String((manifest.cookies||[]).find(c=>c?.name==='c_user')?.value||'').trim();
 const saved=String(manifest.expectedFacebookUserId||'').trim();
 // Old releases incorrectly persisted a numeric login (often a phone number).
 // It is never accepted as an account identity without an authoritative binding.
 const legacy=saved===String(manifest.login||manifest.user||manifest.username||'').trim()&&manifest.expectedFacebookUserIdSource!=='ct_stock';
 if(numeric(saved)&&numeric(cookie)&&saved!==cookie&&!legacy)throw Error('cadastro_account_identity_mismatch');
 return !legacy&&numeric(saved)?saved:numeric(cookie)?cookie:'';
}
async function resolve({nome,manifest,fetchAssigned,save}){
 const cookie=String((manifest.cookies||[]).find(c=>c?.name==='c_user')?.value||'');
 const local=expected(manifest),saved=String(manifest.expectedFacebookUserId||'');
 const login=String(manifest.login||manifest.user||manifest.username||'').trim();
 const legacy=!!saved&&saved===login&&manifest.expectedFacebookUserIdSource!=='ct_stock';
 if(local&&!legacy)return local;
 const bound=await fetchAssigned({profileName:nome});
 if(!bound?.ok||!numeric(bound.expectedFacebookUserId)||Number(bound.stockAccountId)!==Number(manifest.stockAccountId)||String(bound.login||'').trim()!==login)throw Error('cadastro_expected_identity_missing');
 const identity=String(bound.expectedFacebookUserId);
 if(numeric(cookie)&&cookie!==identity)throw Error('cadastro_account_identity_mismatch');
 await save(m=>({...m,expectedFacebookUserId:identity,expectedFacebookUserIdSource:'ct_stock'}));
 return identity;
}
module.exports={expected,resolve};
