'use strict';

// Operator-only preparation. Default invocation is read-only. Never invoked by chat.
const supabase = require('./supabase');
const { PLATFORM_ID, emptyLedger, validLedger, createSharedStore } = require('../project-assistant-budget');
const { assembleSnapshot, canonicalHash } = require('./transactional-repository');
const path = '/rest/v1/companies?id=eq.' + PLATFORM_ID + '&select=id,tenant_revisions(revision,scalar_data,content_hash),tenant_records(collection,position,data)&tenant_records.order=collection.asc,position.asc&limit=1';

async function inspect(client = supabase) {
  if (!client.configured()) throw Error('Existing private Supabase persistence is unavailable. Keep AI disabled.');
  const rows = await (await client.request(path, {signal:AbortSignal.timeout(5000)})).json();
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== PLATFORM_ID || !Array.isArray(rows[0].tenant_records)) throw Error('Existing operations namespace or complete private snapshot unavailable. No changes prepared.');
  const revisions = rows[0].tenant_revisions;
  if (Array.isArray(revisions) && revisions.length > 1) throw Error('Invalid private revision snapshot.');
  const revision = Array.isArray(revisions) ? revisions[0] : revisions;
  const records = rows[0].tenant_records;
  if (!revision) {
    if (records.length) throw Error('Existing records have no revision. Repair through the established recovery process first.');
    return {mode:'insert',records,scalar:{},revision:0};
  }
  if (!Number.isSafeInteger(Number(revision.revision)) || !revision.scalar_data || Array.isArray(revision.scalar_data) || canonicalHash(assembleSnapshot(revision.scalar_data, records)) !== revision.content_hash) throw Error('Private snapshot integrity failed. No changes prepared.');
  if (Object.hasOwn(revision.scalar_data, 'assistantUsage')) {
    if (!validLedger(revision.scalar_data.assistantUsage)) throw Error('Existing ledger is corrupt. Never replace or reset usage accounting; keep AI disabled.');
    return {mode:revision.scalar_data.assistantUsage.closed?'closed':'ready'};
  }
  return {mode:'append',revision:Number(revision.revision),scalar:revision.scalar_data,records};
}

async function initialize(plan, client = supabase) {
  if (plan.mode === 'ready' || plan.mode === 'closed') return plan;
  if (plan.mode === 'append') {
    if (!await createSharedStore(client).compareAndSwap(plan, emptyLedger())) throw Error('Private revision changed. Re-run read-only inspection; do not overwrite it.');
  } else if (plan.mode === 'insert') {
    const scalar = {assistantUsage:emptyLedger()};
    await client.request('/rest/v1/tenant_revisions?on_conflict=company_id', {
      method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify({company_id:PLATFORM_ID,revision:1,scalar_data:scalar,content_hash:canonicalHash(scalar),updated_at:new Date().toISOString()})
    });
  } else throw Error('Unsupported initialization plan.');
  // A lost acknowledgement is recovered by reinspection. Never retry with a replacement ledger.
  const checked = await inspect(client);
  if (checked.mode !== 'ready') throw Error('Initialization was not confirmed. Re-run read-only inspection and keep AI disabled.');
  return checked;
}

if (require.main === module) (async()=>{
  if (process.argv.slice(2).some(arg=>arg!=='--apply')) throw Error('Only --apply is accepted. Default is read-only.');
  const plan=await inspect();
  console.log(JSON.stringify({mode:plan.mode,readOnly:!process.argv.includes('--apply'),existingPrivateNamespace:PLATFORM_ID,newSchemaOrGrants:false}));
  if (process.argv.includes('--apply')) console.log(JSON.stringify(await initialize(plan)));
})().catch(()=>{console.error('Assistant ledger readiness failed. Keep AI disabled and check the existing persistence/permissions and recovery documentation. No secrets or private snapshot printed.');process.exitCode=1;});
module.exports={inspect,initialize};
