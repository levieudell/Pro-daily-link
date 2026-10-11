'use strict';
// Custody for ten named existing resource writes. No caller-selected capability
// or arbitrary handler supplies authority. Physical/provider writes stay fenced.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateWorkspace } = require('./compat-workspace-evidence');
const { validateAccounts } = require('./account-evidence');
const input = require('./resource-inputs'), delta = require('./resource-deltas');
const purpose = 'workspace-resource-save-v1';
const outcomePurpose = 'workspace-resource-outcome-v1';
const previews = 'resourcePreviews', receipts = 'resourceReceipts', reconciliations = 'resourceReconciliations';
const privateNames = [previews, receipts, reconciliations];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const exact = (value, keys) => input.object(value, keys) && Object.keys(value).length === keys.length;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = input.fail;
function reviewTarget(db, op) {
  const estimates=op.kind.startsWith('estimate'),reports=['reportDisposition','reportSafety','reportRate','reportRemove'].includes(op.kind);
  if(!estimates&&!reports&&op.kind!=='projectRateSettings')return null;
  const parts=op.path.split('/'),report=reports?db.reports.find(row=>row.id===Number(parts[3])):null;
  const projectId=reports?db.projects[report.project]?.id:op.kind.startsWith('estimateImport')?op.details.projectId:Number(parts[3]);
  const project=db.projects.find(row=>row.id===projectId),target={project:{id:project.id,name:String(project.name).slice(0,160)}};
  if(report)target.report={id:report.id,date:String(report.date).slice(0,10),foreman:String(report.foreman).slice(0,160),status:String(report.status).slice(0,40)};
  if(op.kind==='estimateItemEdit'||op.kind==='estimateItemRemove'){const row=project.estimateItems.find(row=>row.id===Number(parts[5]));target.item=dtoPick(row);}
  if(op.kind==='estimateProposalApprove'){const row=project.estimateProposals.find(row=>row.id===Number(parts[5]));target.proposal=dtoPick(row);}
  if(op.kind.startsWith('estimateImport')){const row=db.estimateImports.find(row=>row.id===Number(parts[3]));target.document={id:row.id,filename:String(row.filename).slice(0,180),status:String(row.status).slice(0,40)};}
  return target;
  function dtoPick(row){const quantity=Number(row.plannedQuantity);if(!Number.isFinite(quantity)||quantity<0)fail(409,'Reviewed estimate quantity needs reconciliation.');return {id:row.id,name:String(row.name).slice(0,160),plannedQuantity:quantity,unit:String(row.unit).slice(0,20)};}
}
function envelope(value) {
  if (!exact(value, ['token', 'version', 'confirmed', 'requestId']) || !uuid(value.token) || !hash(value.version) || value.confirmed !== true || !requestId(value.requestId)) fail(400, 'Review and explicitly confirm a current resource preview.');
  return value;
}
function createHandler(h) {
  if (!Buffer.isBuffer(h.key) || h.key.length !== 32) fail(503, 'Resource custody key required.');
  const digest = row => crypto.createHmac('sha256', h.key).update(purpose + ':' + canonicalHash(delta.omit(row, ['proof']))).digest('hex');
  const sign = row => ({ ...row, proof: digest(row) });
  function valid(db) {
    for (const name of privateNames) {
      const rows = db[name] === undefined ? [] : db[name], ids = new Set(), requests = new Set();
      if (!Array.isArray(rows) || rows.length > 50000 || Buffer.byteLength(JSON.stringify(rows)) > 8000000) fail(409, 'Resource custody capacity requires reconciliation.');
      for (const row of rows) {
        const common = ['id', 'purpose', 'companyId', 'actorId', 'actorRole', 'sessionHash', 'sessionBinding', 'authorityBefore', 'createdAt', 'proof'];
        const fields = [...common, ...(name === previews ? ['operation', 'version', 'expiresAt', 'reason', 'impact', 'openingRevision', 'reviewRevision'] : name === receipts ? ['operation', 'version', 'previewId', 'requestId', 'reason', 'status', 'result', 'retained', 'authorityAfter', 'reviewRevision', 'committedRevision'] : ['authorityAfter', 'revision', 'retained', 'result'])];
        if (!exact(row, fields) || !uuid(row.id) || ids.has(row.id) || row.purpose !== purpose || row.companyId !== db.company.id || !input.id(row.actorId) || !['owner','admin','project_manager','foreman','field'].includes(row.actorRole) || ![row.sessionHash, row.sessionBinding, row.authorityBefore, row.proof].every(hash) || !timestamp(row.createdAt)) fail(409, 'Resource custody needs reconciliation.');
        if (!crypto.timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(digest(row), 'hex'))) fail(409, 'Resource custody proof could not be verified.');
        if (name !== reconciliations) {
          if (!delta.equal(input.parse(row.operation), row.operation) || !hash(row.version) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500) fail(409, 'Resource save identity needs reconciliation.');
          if (name === previews) {
            if (!Number.isSafeInteger(row.openingRevision)||row.openingRevision<0||row.reviewRevision!==row.openingRevision+1||!timestamp(row.expiresAt) || Date.parse(row.expiresAt) <= Date.parse(row.createdAt) || Date.parse(row.expiresAt) > Date.parse(row.createdAt) + 600000 || !exact(row.impact, ['kind', 'details', 'changedCollections', 'affectedMembers', 'affectedAccounts', 'accountScopes', ...(Object.hasOwn(row.impact||{},'taskChanges')?['taskChanges']:[]), ...(Object.hasOwn(row.impact||{},'taskAssignment')?['taskAssignment']:[]), ...(Object.hasOwn(row.impact||{},'subcontractorEffects')?['subcontractorEffects']:[])])) fail(409, 'Resource preview needs reconciliation.');
            if(row.impact.taskChanges!==undefined){if(!Array.isArray(row.impact.taskChanges)||row.impact.taskChanges.length>10000)fail(409,'Task preview requires reconciliation.');for(const change of row.impact.taskChanges){if(!exact(change,['id','name','before','after'])||!input.id(change.id)||typeof change.name!=='string'||change.name.length>160)fail(409,'Task preview requires reconciliation.');for(const value of [change.before,change.after])if(value!==null&&(!exact(value,['startDate','endDate'])||!input.date(value.startDate)||!input.date(value.endDate)))fail(409,'Task preview requires reconciliation.');}}
            for(const [name,keys]of [['taskAssignment',['createdCount','mergedCount','skippedCount']],['subcontractorEffects',['revokedLinkCount','cancelledReminderCount']]])if(row.impact[name]!==undefined&&(!exact(row.impact[name],keys)||Object.values(row.impact[name]).some(value=>!Number.isSafeInteger(value)||value<0||value>50000)))fail(409,'Resource consequences require reconciliation.');
          } else {
            const identity = row.actorId + ':' + row.requestId;
            if (!uuid(row.previewId) || !requestId(row.requestId) || requests.has(identity) || ![200, 201].includes(row.status) || !hash(row.authorityAfter) || !row.result || typeof row.result !== 'object' || Array.isArray(row.result) || !row.retained || typeof row.retained !== 'object') fail(409, 'Resource receipt needs reconciliation.');
            const preview = (db[previews] || []).find(value => value.id === row.previewId);
            if (!preview || ['actorId', 'actorRole', 'companyId', 'sessionHash', 'sessionBinding', 'authorityBefore', 'version', 'reason','reviewRevision'].some(key => preview[key] !== row[key]) || row.committedRevision!==row.reviewRevision+1 || !delta.equal(preview.operation, row.operation)) fail(409, 'Resource receipt lost its original preview.');
            requests.add(identity);
          }
        } else if (!hash(row.authorityAfter) || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Array.isArray(row.retained) || !Array.isArray(row.result)) fail(409, 'Crew reconciliation needs review.');
        ids.add(row.id);
      }
    }
  }
  const version = (db, auth) => canonicalHash({ source: delta.omit(db, privateNames), authority: h.authority(db, auth).authority });
  function fresh(req, db) {
    validateAccounts(db); validateWorkspace(db); delta.validateDirectory(db);
    const auth = h.authenticate(req, db).auth;
    if (!auth || Date.parse(auth.session.expiresAt) <= Date.now()) fail(401, 'Current resource account required.');
    if (h.accountAccess(db.company).locked) fail(402, 'Company access requires Owner review.');
    return auth;
  }
  function impact(before, after, op, checked) {
    const registry=require('./capability-registry'),dto=require('./compat-workspace-projections');
    const scope=(db,user)=>{
      const actor=registry.actor(db,registry.normalize(user)),view=dto.bootstrap(db,actor,h),cards=(db.timeCards||[]).filter(row=>require('./time-review-access').cardInScope(db,actor,row));
      return {...Object.fromEntries(['projects','team','assignments','reports','workdays'].map(name=>[name,(view[name]||[]).map(row=>row.id).sort((a,b)=>String(a).localeCompare(String(b)))])),timeCards:cards.map(row=>row.id).sort((a,b)=>String(a).localeCompare(String(b))),pricing:h.canViewPricing(db,actor)};
    };
    const accountScopes=before.users.filter(user=>user.status==='Active').map(user=>({id:user.id,role:user.role,before:scope(before,user),after:scope(after,after.users.find(row=>row.id===user.id))})).filter(row=>!delta.equal(row.before,row.after));
    const datePair=(db,row)=>{if(!row)return null;const value=input.date(row.startDate)&&input.date(row.endDate)?row:require('./project-schedule').scheduleTasks((db.projectTasks||[]).filter(task=>Number(task.projectId)===Number(row.projectId)),db.projects.find(project=>Number(project.id)===Number(row.projectId))?.startDate).tasks?.find(task=>task.id===row.id);return value&&input.date(value.startDate)&&input.date(value.endDate)?{startDate:value.startDate,endDate:value.endDate}:null;};
    const taskChange = row => ({id:row.id,name:row.name,before:datePair(before,before.projectTasks?.find(old=>old.id===row.id)),after:datePair(after,after.projectTasks?.find(next=>next.id===row.id))});
    const consequences={...(op.kind.startsWith('projectTask')||op.kind==='projectDates'?{taskChanges:[...new Map([...(before.projectTasks||[]),...(after.projectTasks||[])].filter(row=>!delta.equal((before.projectTasks||[]).find(old=>old.id===row.id),(after.projectTasks||[]).find(next=>next.id===row.id))).map(row=>[row.id,taskChange(row)])).values()]}:{}),...(op.kind.startsWith('subcontractor')?{subcontractorEffects:{revokedLinkCount:(before.subcontractorLinks||[]).filter(row=>row.status==='Active'&&(after.subcontractorLinks||[]).find(next=>next.id===row.id)?.status==='Revoked').length,cancelledReminderCount:(before.workspaceComplianceJobs||[]).filter(row=>row.status==='queued'&&(after.workspaceComplianceJobs||[]).find(next=>next.id===row.id)?.status==='cancelled').length}}:{})};
    return { ...consequences,...(op.kind==='projectTaskAssign'?{taskAssignment:{createdCount:checked.data.created,mergedCount:checked.data.merged,skippedCount:checked.data.skipped}}:{}), kind: op.kind, details: structuredClone(op.details), changedCollections: [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !delta.equal(before[key], after[key])), affectedMembers: before.team.filter(row => !delta.equal(row, after.team.find(value => value.id === row.id))).map(row => row.id), affectedAccounts: [...new Set([...before.users.filter(row => !delta.equal(row, after.users.find(value => value.id === row.id))).map(row => row.id),...accountScopes.map(row=>row.id)])],accountScopes };
  }
  async function execute(req, db, op) {
    const auth = fresh(req, db); input.authorize(db, auth, op, h);
    const details = structuredClone(op.details); delete details.contractValueTracking;
    const actorRequest = { auth, headers: req.headers };
    let result = await h.run(actorRequest, { ...op, details: op.kind === 'companySettings' ? details : op.details }, db);
    if (result.response.status >= 400) fail(result.response.status, result.response.data?.error || 'Resource change unavailable.');
    if (op.kind === 'companySettings' && Object.hasOwn(op.details, 'contractValueTracking')) {
      result = await h.run(actorRequest, { method: 'PATCH', path: '/api/company/contract-value-tracking', details: { enabled: op.details.contractValueTracking } }, result.candidate);
      if (result.response.status >= 400) fail(result.response.status, 'The complete Company save could not be validated.');
    }
    const afterAuth = fresh(req, result.candidate);
    const family = input.extension(op); if (family?.prepareCandidate) family.prepareCandidate(db, result.candidate, op, afterAuth, h, input);
    const checked = delta.validate(db, result.candidate, op, afterAuth, h);
    return { candidate: result.candidate, status: op.kind.endsWith('Create') || op.kind === 'catalogApply' ? 201 : 200, data: checked.data, retained: checked.retained, impact: impact(db, result.candidate, op, checked), afterAuth };
  }
  function publicImpact(db,auth,value){
    const result={kind:value.kind,details:value.details,...(value.taskChanges?{taskChanges:value.taskChanges}:{}),...(value.taskAssignment?{taskAssignment:value.taskAssignment}:{}),...(['owner','admin'].includes(auth.user.role)&&value.subcontractorEffects?{subcontractorEffects:value.subcontractorEffects}:{})};
    if(!['owner','admin'].includes(auth.user.role))return result;
    const gates=require('./capability-registry').effective(db,auth.user),allowed=new Set(['projects','team',...(gates.scheduling.view?['assignments']:[]),...(gates.daily.viewReports?['reports']:[]),...(gates.daily.viewWorkdays?['workdays']:[]),...(gates.timeReview.viewCards?['timeCards']:[])]);
    return {...result,affectedMemberCount:value.affectedMembers.length,affectedAccountCount:value.affectedAccounts.length,accountChanges:value.accountScopes.map(row=>({id:row.id,role:row.role,changes:Object.keys(row.before).filter(name=>allowed.has(name)).map(name=>({collection:name,removed:row.before[name].filter(id=>!row.after[name].includes(id)).length,added:row.after[name].filter(id=>!row.before[name].includes(id)).length})).filter(change=>change.removed||change.added),...(h.canViewPricing(db,auth.user)&&row.before.pricing!==row.after.pricing?{pricingBefore:row.before.pricing,pricingAfter:row.after.pricing}:{})})).filter(row=>row.changes.length||Object.hasOwn(row,'pricingBefore'))};
  }
  function original(db, auth, tuple, outcome=false) {
    valid(db);
    const row = (db[receipts] || []).find(value => value.actorId === auth.user.id && value.requestId === tuple.requestId);
    const current = h.authority(db, auth);
    if (!row || row.actorRole!==auth.user.role || row.previewId !== tuple.token || row.version !== tuple.version || row.operation.method !== tuple.method || row.operation.path !== tuple.path || row.sessionHash !== auth.session.tokenHash || row.sessionBinding !== current.sessionBinding || !outcome&&row.authorityAfter !== current.authority) fail(409, 'The original resource outcome needs review with its current originating session.');
    input.authorizeActor(auth,row.operation);
    return row;
  }
  function currentResult(db, auth, row, first=false) {
    const dto=require('./compat-workspace-projections'),op=row.operation,visible=dto.bootstrap(db,auth.user,h);
    const family = input.extension(op); if (family) return family.currentResult(db, auth, row, first, h, input);
    const collection={customerCreate:'customers',projectCreate:'projects',teamCreate:'team'}[op.kind];
    if(collection){const current=(visible[collection]||[]).find(value=>value.id===row.result.id);return current||{id:row.result.id,...(first?op.details:{}),receiptId:row.id};}
    if(op.kind==='projectArchive'){const current=visible.projects.find(value=>value.id===Number(op.path.split('/')[3]));if(!current)fail(409,'Current project readback requires review.');return current;}
    if(op.kind.startsWith('crew')){
      const id=row.result.crew.id;
      // The original acknowledgement names the original operation. Directory
      // readback is current; a recycled ID must never identify a replacement.
      return {...(op.kind==='crewRemove'?{ok:true}:{}),crew:first?delta.crew(row.result.crew):{id},receiptId:row.id,crews:(db.crews||[]).map(delta.crew),team:delta.memberResponse(db,auth.user)};
    }
    if(['companySettings','contractTracking'].includes(op.kind))return dto.company(db.company,h.canViewPricing(db,auth.user));
    if(op.kind==='activityCreate'){const current=(db.companyActivityCodes||[]).find(value=>value.id===row.result.id);return current&&require('./capability-registry').effective(db,auth.user).timeWrite.viewActivities?dto.pick(current,['id','name','active']):{id:row.result.id,...(first?{name:op.details.name,active:true}:{}),receiptId:row.id};}
    fail(409,'Current resource readback requires review.');
  }
  function deliver(db, auth, context, url, method) {
    if (!context.resourceReturn) return null;
    const tuple = context.resourceReturn, lookup=method==='POST'&&url.pathname==='/api/resources/original-result', row = original(db, auth, tuple,lookup), current = h.authority(db, auth);
    if (!(method === row.operation.method && url.pathname === row.operation.path || method === 'POST' && url.pathname === '/api/resources/original-result')) fail(409, 'Unexpected resource receipt delivery.');
    const replay=context.response.data.originalSaveResult===true;
    context.response.data=lookup?{originalSaveResult:true,receipt:{id:row.id,token:row.previewId,version:row.version,requestId:row.requestId,method:row.operation.method,path:row.operation.path,committedRevision:row.committedRevision,status:'committed'}}:{...currentResult(db,auth,row,!replay),...(replay?{originalSaveResult:true}:{})};
    return { purpose:lookup?outcomePurpose:purpose, receiptId: row.id, token: row.previewId, version: row.version, requestId: row.requestId, method: row.operation.method, path: row.operation.path, companyId: row.companyId, actorId: row.actorId, sessionBinding: current.sessionBinding, originalAuthority:row.authorityBefore, from: lookup?current.authority:row.authorityBefore, to: lookup?current.authority:row.authorityAfter };
  }
  async function crewRead(req, res) {
    const before = h.readDb(); fresh(req, before);
    const result = await h.run(req, { method: 'GET', path: '/api/crews', details: {} }, before);
    if (result.response.status >= 400) fail(result.response.status, 'Crew directory unavailable.');
    const rows = delta.reconciliation(before, result.candidate);
    let db = before;
    if (!delta.equal(before.crews, result.candidate.crews)) {
      await h.assertCurrent(req); db = result.candidate;
      const afterAuth = fresh(req, db), opening = h.authority(before, req.auth), current = h.authority(db, afterAuth);
      db[reconciliations] ||= []; db[reconciliations].push(sign({ id: crypto.randomUUID(), purpose, companyId: db.company.id, actorId: req.auth.user.id, actorRole:req.auth.user.role, sessionHash: req.auth.session.tokenHash, sessionBinding: opening.sessionBinding, authorityBefore: opening.authority, authorityAfter: current.authority, revision: h.revision(), createdAt: new Date().toISOString(), retained: structuredClone(before.crews || []), result: rows.map(delta.crew) }));
      db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'crew_directory_reconciled', actorId: req.auth.user.id, actor: req.auth.user.name, at: new Date().toISOString(), detail: 'Existing crew labels reconciled; previous directory retained.' });
      valid(db); h.writeDb(db);
    }
    const auth = fresh(req, db), labels = new Set((h.workspace(db, auth.user).team || []).map(row => String(row.crew || '').toLowerCase()));
    h.json(res, 200, rows.filter(row => ['owner', 'admin'].includes(auth.user.role) || labels.has(row.name.toLowerCase())).map(delta.crew)); return true;
  }
  async function handle(req, res, url) {
    const preview = req.method === 'POST' && url.pathname === '/api/resources/preview';
    const lookup = req.method === 'POST' && url.pathname === '/api/resources/original-result';
    const selected = input.route(req.method, url.pathname);
    if (!preview && !lookup && !selected && !(req.method === 'GET' && ['/api/crews','/api/crews/eligible-members'].includes(url.pathname))) return false;
    try {
      if (url.search) fail(400, 'Resource operations accept no query overrides.');
      const db = h.readDb(); valid(db); await h.assertCurrent(req);
      if(req.method==='GET' && selected==='projectTasksView'){const auth=fresh(req,db),op=input.parse({kind:selected,method:req.method,path:url.pathname,details:{}});input.authorize(db,auth,op,h);h.json(res,200,require('./resource-project-tasks').visible(db,auth.user,Number(url.pathname.split('/')[3]),input));return true;}
      if(req.method==='GET'&&url.pathname==='/api/crews/eligible-members'){const auth=fresh(req,db);if(!['owner','admin'].includes(auth.user.role))fail(403,'Current Owner or Admin permission required.');h.json(res,200,{memberIds:input.eligibleMembers(db)});return true;}
      if (req.method === 'GET') return await crewRead(req, res);
      const value = await h.body(req); await h.assertCurrent(req); const auth = fresh(req, db), opening = h.authority(db, auth);
      if (preview) {
        if (!exact(value, ['operation', 'expectedRevision', 'reason']) || value.expectedRevision !== h.revision()) fail(409, 'Refresh before reviewing this resource change.');
        const op = input.parse(value.operation), reason = input.text(value.reason, 500, true), proposed = await execute(req, db, op); await h.assertCurrent(req);
        const at = Date.now(), row = sign({ id: crypto.randomUUID(), purpose, companyId: db.company.id, actorId: auth.user.id, actorRole:auth.user.role, sessionHash: auth.session.tokenHash, sessionBinding: opening.sessionBinding, authorityBefore: opening.authority, operation: op, version: version(db, auth), openingRevision:h.revision(),reviewRevision:h.revision()+1, createdAt: new Date(at).toISOString(), expiresAt: new Date(Math.min(at + 600000, Date.parse(auth.session.expiresAt))).toISOString(), reason, impact: proposed.impact });
        if (Buffer.byteLength(JSON.stringify(db[receipts] || [])) + Buffer.byteLength(JSON.stringify({result:proposed.data,retained:proposed.retained,operation:op})) + 30000 > 8000000) fail(409, 'Resource receipt capacity needs review before another save.');
        const target=reviewTarget(db,op);
        db[previews] ||= []; db[previews].push(row); valid(db); h.writeDb(db);
        h.json(res, 200, { token: row.id, version: row.version, reason, impact: publicImpact(db,auth,row.impact), proposed: proposed.data, ...(target?{reviewTarget:target}:{}), authorityBefore: row.authorityBefore, expiresAt: row.expiresAt }); return true;
      }
      if (lookup) {
        if (!exact(value, ['token', 'version', 'requestId', 'method', 'path']) || !uuid(value.token) || !hash(value.version) || !requestId(value.requestId) || !input.route(value.method, value.path)) fail(400, 'Use the original bounded resource receipt identity.');
        const row = original(db, auth, value,true); h.returnReceipt(value); h.json(res, 200, { originalSaveResult: true, receipt:{id:row.id,token:row.previewId,version:row.version,requestId:row.requestId,method:row.operation.method,path:row.operation.path,committedRevision:row.committedRevision,status:'committed'} }); return true;
      }
      const proof = envelope(value), tuple = { ...delta.omit(proof, ['confirmed']), method: req.method, path: url.pathname };
      const prior = (db[receipts] || []).find(row => row.actorId === auth.user.id && row.requestId === proof.requestId);
      if (prior) { const row = original(db, auth, tuple); if(row.operation.kind==='projectTaskAssign')h.resumeTaskAssignments(db,{auth},row); h.returnReceipt(tuple); h.json(res, row.status, { ...currentResult(db,auth,row), originalSaveResult: true }); return true; }
      const row = (db[previews] || []).find(row => row.id === proof.token);
      if (!row || row.reviewRevision!==h.revision() || row.actorRole!==auth.user.role || row.version !== proof.version || row.operation.method !== req.method || row.operation.path !== url.pathname || row.actorId !== auth.user.id || row.sessionHash !== auth.session.tokenHash || row.sessionBinding !== opening.sessionBinding || row.authorityBefore !== opening.authority || Date.parse(row.expiresAt) <= Date.now() || row.version !== version(db, auth) || (db[receipts] || []).some(receipt => receipt.previewId === row.id)) fail(409, 'Company changed. Review a new resource preview.');
      h.guardDeadline(row.expiresAt);
      const result = await execute(req, db, row.operation); await h.assertCurrent(req);
      if (!delta.equal(row.impact, result.impact)) fail(409, 'Resource consequences changed. Review again.');
      result.candidate.auditLog ||= []; result.candidate.auditLog.push({ id: crypto.randomUUID(), type: 'resource_changed', actorId: auth.user.id, actor: auth.user.name, at: new Date().toISOString(), resourceKind: row.operation.kind, previewId: row.id, requestId: proof.requestId, reason: row.reason, detail: 'Confirmed resource effects retained with the original receipt.' });
      if(row.operation.kind==='projectTaskAssign'){const ids=(result.candidate.assignments||[]).filter(value=>!delta.equal(value,(db.assignments||[]).find(old=>old.id===value.id))).map(value=>value.id);result.retained.assignmentJobs=h.stageTaskAssignments(result.candidate,{auth:result.afterAuth},ids,row.operation.details.memberId);fresh(req,result.candidate);}
      result.candidate[receipts] ||= []; result.candidate[receipts].push(sign({ id: crypto.randomUUID(), purpose, companyId: db.company.id, actorId: auth.user.id, actorRole:auth.user.role, sessionHash: auth.session.tokenHash, sessionBinding: opening.sessionBinding, authorityBefore: opening.authority, authorityAfter: h.authority(result.candidate, result.afterAuth).authority, operation: row.operation, version: row.version, previewId: row.id, requestId: proof.requestId, reason: row.reason, reviewRevision:row.reviewRevision,committedRevision:h.revision()+1, createdAt: new Date().toISOString(), status: result.status, result: result.data, retained: result.retained }));

      valid(result.candidate); h.writeDb(result.candidate); h.returnReceipt(tuple); h.json(res, result.status, result.data); return true;
    } catch (error) { if (![400, 401, 402, 403, 404, 409, 503].includes(error.statusCode)) throw error; h.json(res, error.statusCode, { error: error.message }); return true; }
  }
  return { handle, valid, deliver };
}
module.exports = { createHandler, purpose, previews, receipts, reconciliations };
