'use strict';
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const routes = require('./compat-workspace-routes');
const dto = require('./compat-workspace-projections');
const { validateWorkspace } = require('./compat-workspace-evidence');
const registry = require('./capability-registry');
const scheduling = require('./scheduling-access');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
function createWorkspace(h) {
  const options = h.options;
  for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','SUPABASE_SECRET_KEY','PDL_PLATFORM_KEY'])if(process.env[name])fail(503,'Synthetic workspace cannot use production provider credentials.');
  if (!options.lifecycle || !Buffer.isBuffer(options.workspaceKey) || options.workspaceKey.length !== 32) fail(503, 'Synthetic workspace proof key required');
  async function assertCurrent(req) {
    const context = h.context(), loaded = await options.repository.load(options.companyId);
    if (!loaded || loaded.revision !== context.transactionalRevision || loaded.contentHash !== canonicalHash(context.openingSnapshot)) fail(409, 'Company changed. Refresh current records.');
    validateWorkspace(loaded.snapshot);
    const auth = h.authenticate(req, loaded.snapshot).auth;
    if (!auth || Date.parse(auth.session.expiresAt) <= Date.now()) fail(401, 'Authentication required');
    if (h.accountAccess(loaded.snapshot.company).locked && context.route !== '/api/billing') fail(402, 'Account access requires owner billing review');
    return auth;
  }
  const common = { readDb: h.readDb, writeDb: h.writeDb, body: h.body, json: h.json, raw: h.raw, revision: () => h.context().transactionalRevision, assertCurrent, run: h.run, guardDeadline: value => { const ctx=h.context();ctx.businessDeadline=new Date(Math.min(Date.parse(value),ctx.businessDeadline?Date.parse(ctx.businessDeadline):Infinity)).toISOString(); } };
  const notes = require('./notes-admission').createHandler({ ...common, run: async (req, res, url) => { const result = await h.run(req, { method: req.method, path: url.pathname + url.search, details: ['POST', 'PATCH'].includes(req.method) ? await h.body(req) : {} }); if (result.dirty && result.response.status < 400) h.writeDb(result.candidate); if (Object.hasOwn(result.response, 'raw')) h.raw(res, result.response); else h.json(res, result.response.status, result.response.data); }, response: () => h.context().response, baselineProjectAllowed: h.canAccessProject });
  const daily = require('./daily-admission').createHandler({ ...common, adoptActual: h.adoptAssignmentActualTimes, presentReport: h.presentReport, exportProjection: h.dailyExportProjection });
  const writes = require('./time-write-admission').createHandler({ ...common, activities: db => h.companyActivities(structuredClone(db)) });
  const review = require('./time-review-admission').createHandler({ ...common, isApproved: h.timeCardIsApproved, statusText: h.timeCardStatusText, completeCard: h.completeCard, overlap: h.timeCardOverlap, upsert: h.upsertTimeCard, presentCard: h.presentTimeCard, filterCards: h.filterTimeCards, mergeCopies: h.mergeTimeCardCopies, fieldAccess: h.fieldAccess, signingKey: options.workspaceKey });
  const leave = require('./time-off-admission').createHandler(common);
  const assignmentDelivery=options.assignmentSend?require('./compat-assignment-delivery').createDelivery({repository:options.repository,companyId:options.companyId,send:options.assignmentSend,authenticateSession:h.authenticateSession,accountAccess:h.accountAccess,key:options.workspaceKey}):null;
  const assignmentIds=data=>(data.assignments||[data]).map(row=>row.id);
  const scheduleWorkflows=require('./schedule-workflow-admission').createHandler({...common,key:options.workspaceKey,stageAssignments:(db,req,ids)=>{if(assignmentDelivery)h.context().workspaceAssignmentJobIds=assignmentDelivery.stage(db,req,ids);}});
  const direct = require('./workspace-direct-admission').createHandler({...common,key:options.workspaceKey,projectAllowed:h.canAccessProject,
    stageAssignmentDelivery:(db,req,data)=>{if(assignmentDelivery)h.context().workspaceAssignmentJobIds=assignmentDelivery.stage(db,req,assignmentIds(data));},
    resumeAssignmentDelivery:(db,data)=>{if(assignmentDelivery)h.context().workspaceAssignmentJobIds=assignmentDelivery.valid(db).filter(job=>job.status==='queued'&&job.source.assignments.some(row=>assignmentIds(data).includes(row.id))).map(job=>job.id);}});
  const compliance=options.complianceSend?require('./compat-workspace-delivery').createCompliance({repository:options.repository,companyId:options.companyId,requirements:h.subcontractorRequirements,send:options.complianceSend,authenticateSession:h.authenticateSession,accountAccess:h.accountAccess,key:options.workspaceKey}):null;
  const billing=options.billingProvider?require('./compat-workspace-billing').createBilling({repository:options.repository,companyId:options.companyId,provider:options.billingProvider,platformSink:options.billingPlatformSink,journal:options.billingJournal,authenticateSession:h.authenticateSession,key:options.workspaceKey,plans:h.billingPlans,apply:h.applyBilling}):null;
  const reconciliation=require('./compat-workspace-reconciliation'),repairs=reconciliation.createLedger(options.workspaceKey,options.companyId);
  function stageBilling(db,req,force=false) {
    if(!db.company.stripeSubscriptionId)return;
    if(!billing)fail(503,'Subscription refresh requires its reviewed synthetic billing contract.');
    const before=canonicalHash(db),id=billing.stage(db,req,force);if(canonicalHash(db)!==before)h.writeDb(db);h.context().workspaceBillingJobId=id;
  }
  function workspace(db, user) {
    let base;
    if (['field', 'foreman'].includes(user.role)) { const member = db.team.find(row => Number(row.id) === Number(user.memberId)); if (!member) fail(404, 'Field user not found'); base = h.fieldWorkspace(db, member, user); }
    else if (user.role === 'project_manager') base = h.managerWorkspace(db, user);
    else base = { ...db, currentUser: user, scheduleAvailability: h.scopedScheduleAvailability(db, user), dailyTemplates: h.scopedTemplateList(db, user) };
    base.company = h.publicCompanyLogo(base.company);
    return base;
  }
  const helpers = { workspace, canViewPricing: h.canViewPricing };
  const policyApi=require('./role-policy-api');
  const policy=policyApi.createHandler({readDb:h.readDb,writeDb:h.writeDb,body:h.body,json:h.json,revision:()=>h.context().transactionalRevision,assertCurrent,
    baselineProjectAllowed:h.canAccessProject,accountAccess:h.accountAccess,key:options.workspaceKey,
    queuedEligible:(db,job)=>assignmentDelivery?assignmentDelivery.authorised(db,job):false,
    workspaceAuthority:(db,req)=>require('./compat-workspace-authority').authority(db,req.auth,h.context().transactionalRevision,options.lifecycle,h.accountAccess).authority,
    policyTransition:(db,proof,req)=>{const current=require('./compat-workspace-authority').authority(db,req.auth,h.context().transactionalRevision,options.lifecycle,h.accountAccess).authority;if(current===proof.workspaceAuthorityAfter)h.context().workspacePolicyFrom=proof.workspaceAuthorityBefore;},
    guardCommit:guard=>{const context=h.context();context.guard={deadline:new Date(Math.min(Date.parse(context.guard?.deadline||guard.authorizedUntil),Date.parse(guard.authorizedUntil))).toISOString()};}});
  const alertAllowed=(user,metrics,item,projectIds)=>user.role!=='project_manager'||item.projectId!=null&&projectIds.has(item.projectId)||item.type==='subcontractor_compliance'&&(metrics.subcontractors||[]).some(row=>Number(row.id)===Number(item.subcontractorId));
  function reconcile(db, req) {
    const user=req.auth.user;repairs.valid(db);reconciliation.source(db);
    const before = structuredClone(db), candidate = structuredClone(db);
    const prepared = h.prepareWorkspace(candidate), owner = h.ensureOwnerTeamMember(candidate);
    if (!prepared && !owner) return db;
    const allowed = new Set(['customers', 'projects', 'reports', 'photos', 'workdays', 'timeCards', 'assignments', 'projectPlans', 'projectTickets', 'subcontractorLinks', 'changes', 'auditLog', 'users', 'team']);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(candidate)])].filter(key => !equal(before[key], candidate[key]));
    if (changed.some(key => !allowed.has(key))) fail(409, 'Unsupported workspace reconciliation');
    reconciliation.candidate(before,candidate,changed);
    // Retain exact previous compound records privately, including history and
    // rows removed by the existing named test-customer/duplicate-Draft repairs.
    repairs.append(candidate,before,user,h.context().transactionalRevision,changed);
    candidate.auditLog ||= []; candidate.auditLog.push({ id: crypto.randomUUID(), type: 'workspace_reconciled', actorId: user.id, actor: user.name, at: new Date().toISOString(), detail: 'Existing workspace repairs retained with their previous records.' });
    h.context().workspaceReconciliationFrom=require('./compat-workspace-authority').authority(before,req.auth,h.context().transactionalRevision,options.lifecycle,h.accountAccess).authority;
    h.writeDb(candidate);req.auth=h.authenticate(req,candidate).auth;if(!req.auth)fail(401,'Current account could not be verified after workspace repair.');return candidate;
  }
  async function read(req, res, url) {
    let db = h.readDb(),user=req.auth.user,gates=registry.effective(db,user);
    if(url.pathname==='/api/workspace-prepare'){
      if(user.role==='owner')stageBilling(db,req,true);
      if(!compliance&&['owner','admin','project_manager'].includes(user.role)&&(db.subcontractors||[]).some(sub=>require('./compat-workspace-delivery').descriptor(db,sub,h.subcontractorRequirements,new Date())))fail(503,'Automatic compliance delivery needs its reviewed provider contract before this workspace can open.');
      if(compliance&&['owner','admin','project_manager'].includes(user.role)){
        if(compliance.stage(db,req))h.writeDb(db);
        h.context().workspaceDeliveryIds=(db.workspaceComplianceJobs||[]).filter(row=>row.status==='queued').map(row=>row.id);
      }
      h.json(res,200,{ok:true});return true;
    }
    if (['/api/state', '/api/action-center', '/api/exceptions'].includes(url.pathname)){db=reconcile(db,req);user=req.auth.user;gates=registry.effective(db,user);}
    if (url.pathname === '/api/state') {
      const userId = url.searchParams.get('userId'), memberId = url.searchParams.get('memberId');
      if (userId && Number(userId) !== user.id || memberId && Number(memberId) !== Number(user.memberId) || url.searchParams.get('role') === 'field' && !['field', 'foreman'].includes(user.role)) fail(403, 'Open your current account workspace.');
      const data=dto.bootstrap(db,user,helpers);
      if(compliance&&['owner','admin','project_manager'].includes(user.role)){const visible=new Set(data.subcontractors.map(row=>Number(row.id))),pending=compliance.valid(db).filter(row=>['sending','uncertain'].includes(row.status)&&visible.has(row.source.subcontractorId));if(pending.length)data.workspaceDependencies={compliance:{status:'uncertain',count:pending.length}};}
      h.json(res, 200, data); return true;
    }
    if(url.pathname==='/api/company/role-capabilities'){if(user.role!=='owner')fail(403,'Account owner permission required');if(h.accountAccess(db.company).locked)fail(402,'Company account is locked');await assertCurrent(req);h.json(res,200,registry.describe(db));return true;}
    const plans=url.pathname.match(/^\/api\/projects\/([1-9]\d*)\/plans$/);
    if(plans){const projectId=Number(plans[1]);if(url.search||!db.projects.some(row=>Number(row.id)===projectId)||!h.canAccessProject(db,user,projectId))fail(404,'Project not found.');
      if(['field','foreman'].includes(user.role)&&!['assignments','workdays'].some(name=>(db[name]||[]).some(row=>Number(row.projectId)===projectId&&row.memberIds.map(Number).includes(Number(user.memberId)))))fail(403,'This plan set is not assigned to you.');
      h.json(res,200,(db.projectPlans||[]).filter(row=>Number(row.projectId)===projectId).map(dto.plan));return true;}
    if(url.pathname==='/api/weather'){const projectId=Number(url.searchParams.get('projectId')),address=url.searchParams.get('address');if(url.searchParams.getAll('projectId').length!==1||url.searchParams.getAll('address').length!==1||[...url.searchParams.keys()].some(k=>!['projectId','address'].includes(k))||!Number.isSafeInteger(projectId)||!h.canAccessProject(db,user,projectId)||address!==db.projects.find(p=>Number(p.id)===projectId)?.site)fail(404,'Project not found.');h.json(res,200,{status:'unavailable',message:'Weather is unavailable in this draft. Enter the conditions recorded on site.'});return true;}
    if (url.pathname === '/api/assignments') { if (!gates.scheduling.view) fail(403, 'Scheduling view permission required'); h.json(res, 200, { assignments: dto.scoped(db,user,helpers).base.assignments.map(dto.assignment) }); return true; }
    if(url.pathname==='/api/changes'){const raw=url.searchParams.get('projectId');if([...url.searchParams.keys()].some(k=>k!=='projectId')||url.searchParams.getAll('projectId').length!==1||!raw||!/^[1-9]\d*$/.test(raw))fail(400,'Choose one current project.');const projectId=Number(raw);if(!['owner','admin','project_manager'].includes(user.role)||!h.canAccessProject(db,user,projectId)||!db.projects.some(p=>Number(p.id)===projectId))fail(404,'Project not found.');
      h.json(res,200,(db.changes||[]).filter(row=>Number(row.projectId)===projectId).map(row=>({...dto.pick(row,['id','projectId','reportId','number','title','status','createdAt','createdBy','updatedAt',...(h.canViewPricing(db,user)?['amount']:[])]),history:dto.history(row.history)})));return true;}
    if (url.pathname === '/api/billing') { if (user.role !== 'owner') fail(403, 'Account owner permission required');stageBilling(db,req,h.accountAccess(db.company).locked);h.json(res, 200, dto.billing(h.billingSummary(db))); return true; }
    if (url.pathname === '/api/daily-templates') { if (db.company.features?.templates !== true) fail(404, 'Not found'); h.json(res, 200, { templates: h.scopedTemplateList(db, user).map(dto.template), defaultTemplateId: db.company.defaultTemplateId || 'standard' }); return true; }
    if(url.pathname==='/api/workspace-identity'){h.json(res,200,{});return true;}
    const aggregates = ['/api/production', '/api/insights', '/api/exceptions', '/api/action-center', '/api/audit-log', '/api/catalog'];
    if (!aggregates.includes(url.pathname)) return false;
    if (!['owner', 'admin', 'project_manager'].includes(user.role)) fail(403, 'Office permission required');
    const { metrics } = dto.scoped(db, user, helpers);
    if (url.pathname === '/api/action-center') {
      // Disabled time cards do not disable the existing workday-based alert.
      // Historic presence remains internal and scoped; typed/profile denials
      // still suppress this derived view even when the feature is disabled.
      const cardSource = db.company.features?.timeCards === true ? db : { ...db, company: { ...db.company, features: { ...db.company.features, timeCards: true } } };
      const cardAuthority = require('./time-review-access').access(cardSource,user).viewCards;
      const alertMetrics = db.company.features?.timeCards === true ? metrics : { ...metrics, timeCards: (db.timeCards||[]).filter(row=>require('./time-review-access').cardInScope(cardSource,user,row)) };
      const result = h.buildActionCenter(alertMetrics), projectIds = new Set(metrics.projects.map(row => row.id));
      result.items = result.items.filter(item => alertAllowed(user,metrics,item,projectIds) && (gates.daily.viewReports || !['exception', 'approval', 'missing_data', 'missing_daily', 'project_risk', 'safety_followup', 'safety_incident_review'].includes(item.type)) && (gates.scheduling.view || item.type !== 'missing_daily') && (item.type!=='scheduled_no_show'||gates.scheduling.view&&gates.daily.viewWorkdays&&cardAuthority&&gates.timeOff.viewRequests)).map(row => dto.pick(row, ['id', 'type', 'severity', 'title', 'detail', 'reportId', 'projectId', 'subcontractorId']));
      result.counts = Object.fromEntries(['urgent', 'high', 'medium'].map(level => [level, result.items.filter(item => item.severity === level).length])); result.counts.total = result.items.length;
      h.json(res, 200, result); return true;
    }
    if (url.pathname === '/api/exceptions') { h.json(res, 200, metrics.reports.filter(row => ['Needs review', 'Missing data'].includes(row.status)).flatMap(report => (report.flags || []).filter(flag => !flag.resolution).map(flag => ({ reportId: report.id, projectId: metrics.projects[report.project]?.id, date: report.date, foreman: report.foreman, status: report.status, ...dto.pick(flag, ['id', 'type', 'message', 'severity']) })))); return true; }
    if (url.pathname === '/api/audit-log') { if (!['owner', 'admin'].includes(user.role)) fail(403, 'Account Owner or Admin permission required'); h.json(res, 200, dto.auditRows(db,user,helpers).slice().reverse()); return true; }
    const context = h.context(), saved = context.db; context.db = metrics;
    let result; try { result = await h.run(req, { method: 'GET', path: url.pathname + url.search }); } finally { context.db = saved; }
    if (result.dirty) fail(409, 'Unexpected dashboard view mutation');
    if (result.response.status >= 400) { h.json(res, result.response.status, { error: result.response.data?.error || 'View unavailable' }); return true; }
    let data = result.response.data;
    if (url.pathname === '/api/production') data = { approvedReports: data.approvedReports, projects: data.projects.map(row => ({ projectId: row.projectId, items: row.items.map(item => dto.pick(item, ['estimateItemId', 'name', 'unit', 'plannedQuantity', 'budgetHours', 'actualQuantity', 'actualLaborHours', 'quantityPercent', 'laborPercent'])) })) };
    if (url.pathname === '/api/insights') data = { generatedAt: data.generatedAt, records: data.records.map(row => dto.pick(row, ['reportId', 'date', 'projectId', 'projectName', 'estimateItemId', 'scope', 'crew', 'unit', 'quantity', 'laborHours', 'targetHoursPerUnit'])) };
    if (url.pathname === '/api/catalog') data = data.map(row => ({ ...dto.pick(row, ['id', 'name', 'category', 'unit', 'description', 'derived', 'createdAt', ...(h.canViewPricing(db,user)?['unitCost']:[]), 'budgetHours', 'targetHoursPerUnit', 'active']), history: dto.pick(row.history || {}, ['approvedEntries', 'totalQuantity', 'totalLaborHours', 'actualHoursPerUnit']) }));
    h.json(res, 200, data); return true;
  }
  async function handle(req, res, url) {
    const context = h.context(); context.route = url.pathname; context.openingSnapshot ||= structuredClone(context.db);
    validateWorkspace(context.db);repairs.valid(context.db);
    policyApi.ledger(context.db,options.workspaceKey);scheduleWorkflows.ledger(context.db);
    for(const [name,handler] of [['workspaceComplianceJobs',compliance],['workspaceBillingJobs',billing],['workspaceAssignmentJobs',assignmentDelivery]]){if(handler)handler.valid(context.db);else if(Object.hasOwn(context.db,name))fail(503,'Stored workspace dependency needs its reviewed contract.');}
    try {
      if (req.method === 'GET' && await read(req, res, url)) return true;
      if(req.method==='POST'&&url.pathname==='/api/billing/recover'){
        if(req.auth.user.role!=='owner')fail(403,'Account owner permission required');
        const input=await h.body(req);if(!billing||!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmed,jobId'||input.confirmed!==true||typeof input.jobId!=='string'||!/^[-a-f0-9]{36}$/.test(input.jobId))fail(400,'Review and explicitly confirm an original billing observation.');
        const job=billing.valid(h.readDb()).find(row=>row.id===input.jobId);if(!job||job.actorId!==req.auth.user.id||job.sessionHash!==req.auth.session.tokenHash)fail(403,'Original owner session required');
        context.workspaceBillingJobId=job.id;context.workspaceBillingRecover=true;h.json(res,200,{});return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/ai/extract'){
        const input=await h.body(req),db=h.readDb(),user=req.auth.user,dailyAccess=require('./daily-access'),keys=['notes','language','projectId','reportId','customTemplateFields','estimateItems'];
        if(!input||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k))||typeof input.notes!=='string'||!input.notes.trim()||input.notes.length>30000||!['en','es','auto','en-US','es-MX'].includes(input.language)||!Number.isSafeInteger(input.projectId)||!dailyAccess.projectAllowed(db,user,input.projectId))fail(400,'Choose your permitted project and enter bounded daily notes.');
        const report=input.reportId==null?null:db.reports.find(row=>row.id===input.reportId);
        if(input.reportId!=null&&(!Number.isSafeInteger(input.reportId)||!report||Number(db.projects[report.project].id)!==input.projectId||!dailyAccess.reportInScope(db,user,report,'editReports'))||input.reportId==null&&!dailyAccess.access(db,user).createReports)fail(403,'Daily draft permission required.');
        await assertCurrent(req);h.json(res,200,dto.localDaily(h.localDailyExtract(input.notes,input.language)));return true;
      }
      if (await policy(req,res,url) || await scheduleWorkflows.handle(req,res,url) || await direct(req, res, url) || await leave(req, res, url) || await review(req, res, url) || await writes(req, res, url) || await daily(req, res, url) || await notes(req, res, url)) return true;
      fail(503, 'Workspace operation is outside this source gate.');
    } catch (error) { if (![400, 401, 402, 403, 404, 409, 503].includes(error.statusCode)) throw error; h.json(res, error.statusCode, { error: error.message }); return true; }
  }
  async function finalize(req,context,url) {
    if(!context.workspaceDeliveryIds?.length&&!context.workspaceBillingJobId&&!context.workspaceAssignmentJobIds?.length)return;
    if(!['/api/workspace-prepare','/api/billing','/api/billing/recover','/api/assignments','/api/schedule/repeat-week'].includes(url.pathname)||context.workspaceDeliveryIds?.length&&!compliance||context.workspaceBillingJobId&&!billing||context.workspaceAssignmentJobIds?.length&&!assignmentDelivery)fail(409,'Unexpected dashboard dependency.');
    let expected={revision:context.savedRevision??context.transactionalRevision,contentHash:canonicalHash(context.candidate??context.openingSnapshot)};
    let billingResult;
    if(context.workspaceBillingJobId){billingResult=await billing.dispatch(context.workspaceBillingJobId,expected,context.workspaceBillingRecover===true);expected=billingResult;}
    for(const id of context.workspaceDeliveryIds||[])expected=await compliance.dispatch(id,expected);
    for(const id of context.workspaceAssignmentJobIds||[])expected=await assignmentDelivery.dispatch(id,expected);
    const loaded=await options.repository.load(options.companyId);
    if(loaded.revision!==expected.revision||loaded.contentHash!==expected.contentHash)fail(409,'Dashboard changed during delivery. Refresh current records.');
    const auth=h.authenticate(req,loaded.snapshot).auth;if(!auth||Date.parse(auth.session.expiresAt)<=Date.now()||!url.pathname.startsWith('/api/billing')&&h.accountAccess(loaded.snapshot.company).locked)fail(401,'Current dashboard access could not be verified.');
    context.finalizedRevision=loaded.revision;context.finalizedContentHash=loaded.contentHash;
    if(!['/api/assignments','/api/schedule/repeat-week'].includes(url.pathname))context.response.data=url.pathname.startsWith('/api/billing')?{...dto.billing(h.billingSummary(loaded.snapshot)),...(billingResult?{refresh:{status:billingResult.status,...(billingResult.observed?{observed:billingResult.observed,jobId:billingResult.jobId}:{})}}:{})}:{ok:true};
  }
  return { supported: routes.supported, handle, finalize, rolePolicies:true };
}
module.exports = { createWorkspace };
