'use strict';
const {bytes}=require('./managed-backup-transport');
function createAdmission(adapter){
  async function rpc(name,input){
    const response=await adapter.request('/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});
    return JSON.parse((await bytes(response,6000000)).toString());
  }
  return {
    get:(id,base)=>rpc('read_managed_backup_job',{p_company_id:id,p_job_key:base}),
    list:id=>rpc('list_managed_backup_jobs',{p_company_id:id}),
    admit:(id,base,descriptor)=>rpc('admit_managed_backup_job',{p_company_id:id,p_job_key:base,p_descriptor:descriptor,p_deadline:new Date(Date.now()+4000).toISOString()})
  };
}
module.exports={createAdmission};
