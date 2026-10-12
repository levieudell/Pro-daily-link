'use strict';
// Reuse the existing server-only Supabase transport and company snapshot. No
// new database connection, initialization, backfill or file copy occurs here.
const {canonicalHash}=require('./transactional-repository');
const {RevisionConflictError}=require('./transactional-repository');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const unavailable=()=>Object.assign(Error('Company permission storage is unavailable.'),{statusCode:503,code:'PDL_ROLES_STORAGE'});
function createRepository(transport){
  if(typeof transport?.request!=='function')throw unavailable();
  return {
    async load(companyId){
      if(!uuid(companyId))throw unavailable();
      const response=await transport.request(`/rest/v1/companies?id=eq.${companyId}&select=data,roles_revision,roles_managed&limit=1`);
      const rows=await response.json();
      if(!Array.isArray(rows)||rows.length!==1||rows[0].roles_managed!==true||rows[0].data?.company?.id!==companyId)throw unavailable();
      const revision=Number(rows[0].roles_revision);
      if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw unavailable();
      return {snapshot:rows[0].data,revision,contentHash:canonicalHash(rows[0].data)};
    },
    async commit(snapshot,expectedRevision,guard){
      if(!uuid(snapshot?.company?.id)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER||!guard||typeof guard.deadline!=='string'||!Number.isFinite(Date.parse(guard.deadline)))throw unavailable();
      let response;
      try{
        const platform=guard.platformId!==undefined;
        if(platform&&(!uuid(guard.platformId)||!Number.isSafeInteger(guard.platformRevision)||guard.platformRevision<0))throw unavailable();
        response=await transport.request(platform?'/rest/v1/rpc/commit_roles_snapshot_with_platform':'/rest/v1/rpc/commit_roles_snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_company_id:snapshot.company.id,p_expected_revision:expectedRevision,p_snapshot:snapshot,p_deadline:guard.deadline,...platform?{p_platform_id:guard.platformId,p_platform_expected_revision:guard.platformRevision}:{} })});
      }catch(error){
        if(/PDL_REVISION_CONFLICT|PDL_ROLES_DEADLINE|40001/.test(String(error.message)))throw new RevisionConflictError(expectedRevision,-1);
        // A transport failure can occur after COMMIT. Never classify it as an
        // unsaved result or silently retry a permission/provider operation.
        throw Object.assign(Error('The saved company result is unknown. Check the original result before retrying.'),{statusCode:503,code:'PDL_COMMIT_OUTCOME_UNKNOWN'});
      }
      let rows;
      try{rows=await response.json();if(!Array.isArray(rows)||rows.length!==1||Number(rows[0].revision)!==expectedRevision+1)throw Error('Invalid acknowledgement');}
      catch{throw Object.assign(Error('The saved company result is unknown. Check the original result before retrying.'),{statusCode:503,code:'PDL_COMMIT_OUTCOME_UNKNOWN'});}
      return {revision:expectedRevision+1,contentHash:canonicalHash(snapshot)};
    }
  };
}
module.exports={createRepository,uuid};
