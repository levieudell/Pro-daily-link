'use strict';
const {uuid}=require('./roles-snapshot-repository');
const fail=()=>{throw Object.assign(Error('This company requires its managed permission authority. Restore the reviewed source configuration before continuing.'),{statusCode:503,code:'PDL_ROLES_WRITER_REQUIRED'});};
async function assertUnmanaged(transport,companyId){
  if(!transport.configured()||!uuid(companyId))return;
  // select=* also works before migration 009; no missing-column fallback can
  // silently enable an old writer after a managed company has been activated.
  const response=await transport.request('/rest/v1/companies?id=eq.'+encodeURIComponent(companyId)+'&select=*&limit=1');
  const rows=await response.json();if(!Array.isArray(rows)||rows.length>1)fail();
  if(rows[0]?.roles_managed===true)fail();
}
module.exports={assertUnmanaged};
