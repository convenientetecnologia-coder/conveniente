'use strict';
// Recebido pelo canal CT existente, sem login, senha ou token adicional.
async function read(){
 const data=require('../ctConfig').readCtConfig().carrierV2;
 if(!data)throw Error('cp2_waiting_ct_configuration');
 if(data.enabled===false)throw Error('cp2_server_not_assigned');
 if(data.baseUrl!=='https://api.convenientetecnologia.com/api/carrier-v2'||typeof data.serverId!=='string'||!/^[a-f0-9-]{36}$/i.test(data.serverId)||!Array.isArray(data.eligiblePhoneIds)||!data.eligiblePhoneIds.length||data.eligiblePhoneIds.some(id=>!/^p[0-9]{3}$/.test(id)))throw Error('cp2_ct_configuration_invalid');
 return {enabled:true,baseUrl:data.baseUrl,serverId:data.serverId,eligiblePhoneIds:data.eligiblePhoneIds,heartbeatMs:10000};
}
module.exports={read};
