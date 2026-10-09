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
  const daily = require('./daily-admission').createHandler({ ...common, presentReport: h.presentReport, exportProjection: h.dailyExportProjection });
  const writes = require('./time-write-admission').createHandler({ ...common, activities: db => h.companyActivities(structuredClone(db)) });
  const review = require('./time-review-admission').createHandler({ ...common, isApproved: h.timeCardIsApproved, statusText: h.timeCardStatusText, completeCard: h.completeCard, overlap: h.timeCardOverlap, upsert: h.upsertTimeCard, presentCard: h.presentTimeCard, filterCards: h.filterTimeCards, mergeCopies: h.mergeTimeCardCopies, fieldAccess: h.fieldAccess, signingKey: options.workspaceKey });
  const leave = require('./time-off-admission').createHandler(common);
  const compliance=options.complianceSend?require('./compat-workspace-delivery').createCompliance({repository:options.repository,companyId:options.companyId,requirements:h.subcontractorRequirements,send:options.complianceSend,authenticateSession:h.authenticateSession,accountAccess:h.accountAccess,key:options.workspaceKey}):null;
  function workspace(db, user) {
    let base;
    if (['field', 'foreman'].includes(user.role)) { const member = db.team.find(row => Number(row.id) === Number(user.memberId)); if (!member) fail(404, 'Field user not found'); base = h.fieldWorkspace(db, member, user); }
    else if (user.role === 'project_manager') base = h.managerWorkspace(db, user);
    else base = { ...db, currentUser: user, scheduleAvailability: h.scopedScheduleAvailability(db, user), dailyTemplates: h.scopedTemplateList(db, user) };
    base.company = h.publicCompanyLogo(base.company);
    return base;
  }
  const helpers = { workspace, canViewPricing: h.canViewPricing };
  const alertAllowed=(user,metrics,item,projectIds)=>user.role!=='project_manager'||item.projectId!=null&&projectIds.has(item.projectId)||item.type==='subcontractor_compliance'&&(metrics.subcontractors||[]).some(row=>Number(row.id)===Number(item.subcontractorId));
  function reconcile(db, user) {
    const before = structuredClone(db), candidate = structuredClone(db);
    const prepared = h.prepareWorkspace(candidate), owner = h.ensureOwnerTeamMember(candidate);
    if (!prepared && !owner) return db;
    const allowed = new Set(['customers', 'projects', 'reports', 'photos', 'workdays', 'timeCards', 'assignments', 'projectPlans', 'projectTickets', 'subcontractorLinks', 'changes', 'auditLog', 'users', 'team']);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(candidate)])].filter(key => !equal(before[key], candidate[key]));
    if (changed.some(key => !allowed.has(key))) fail(409, 'Unsupported workspace reconciliation');
    validateWorkspace(candidate);
    // Retain exact previous compound records privately, including history and
    // rows removed by the existing named test-customer/duplicate-Draft repairs.
    candidate.workspaceReconciliations ||= [];
    candidate.workspaceReconciliations.push({ id: crypto.randomUUID(), purpose: 'legacy-workspace-reconciliation-v1', actorId: user.id, sourceRevision: h.context().transactionalRevision, sourceHash: canonicalHash(before), changed, previous: Object.fromEntries(changed.map(key => [key, before[key] ?? null])), resultHash: canonicalHash(candidate), at: new Date().toISOString() });
    candidate.auditLog ||= []; candidate.auditLog.push({ id: crypto.randomUUID(), type: 'workspace_reconciled', actorId: user.id, actor: user.name, at: new Date().toISOString(), detail: 'Existing workspace repairs retained with their previous records.' });
    h.writeDb(candidate); return candidate;
  }
  async function read(req, res, url) {
    let db = h.readDb(); const user = req.auth.user, gates = registry.effective(db, user);
    if(url.pathname==='/api/workspace-prepare'){
      if(!compliance&&['owner','admin','project_manager'].includes(user.role)&&(db.subcontractors||[]).some(sub=>require('./compat-workspace-delivery').descriptor(db,sub,h.subcontractorRequirements,new Date())))fail(503,'Automatic compliance delivery needs its reviewed provider contract before this workspace can open.');
      if(compliance&&['owner','admin','project_manager'].includes(user.role)){
        if(compliance.stage(db,req))h.writeDb(db);
        h.context().workspaceDeliveryIds=(db.workspaceComplianceJobs||[]).filter(row=>row.status==='queued').map(row=>row.id);
      }
      h.json(res,200,{ok:true});return true;
    }
    if (['/api/state', '/api/action-center', '/api/exceptions'].includes(url.pathname)) db = reconcile(db, user);
    if (url.pathname === '/api/state') {
      const userId = url.searchParams.get('userId'), memberId = url.searchParams.get('memberId');
      if (userId && Number(userId) !== user.id || memberId && Number(memberId) !== Number(user.memberId) || url.searchParams.get('role') === 'field' && !['field', 'foreman'].includes(user.role)) fail(403, 'Open your current account workspace.');
      h.json(res, 200, dto.bootstrap(db, user, helpers)); return true;
    }
    if (url.pathname === '/api/assignments') { if (!gates.scheduling.view) fail(403, 'Scheduling view permission required'); h.json(res, 200, { assignments: dto.scoped(db,user,helpers).base.assignments.map(dto.assignment) }); return true; }
    if (url.pathname === '/api/billing') { if (user.role !== 'owner') fail(403, 'Account owner permission required'); if(db.company.stripeSubscriptionId)fail(503,'Subscription refresh and platform setup records require their reviewed billing contract.');h.json(res, 200, dto.billing(h.billingSummary(db))); return true; }
    if (url.pathname === '/api/daily-templates') { if (db.company.features?.templates !== true) fail(404, 'Not found'); h.json(res, 200, { templates: h.scopedTemplateList(db, user).map(dto.template), defaultTemplateId: db.company.defaultTemplateId || 'standard' }); return true; }
    if(url.pathname==='/api/workspace-identity'){h.json(res,200,{});return true;}
    const aggregates = ['/api/production', '/api/insights', '/api/exceptions', '/api/action-center', '/api/audit-log', '/api/catalog'];
    if (!aggregates.includes(url.pathname)) return false;
    if (!['owner', 'admin', 'project_manager'].includes(user.role)) fail(403, 'Office permission required');
    const { metrics } = dto.scoped(db, user, helpers);
    if (url.pathname === '/api/action-center') {
      const result = h.buildActionCenter(metrics), projectIds = new Set(metrics.projects.map(row => row.id));
      result.items = result.items.filter(item => alertAllowed(user,metrics,item,projectIds) && (gates.daily.viewReports || !['exception', 'approval', 'missing_data', 'missing_daily', 'project_risk', 'safety_followup', 'safety_incident_review'].includes(item.type)) && (gates.scheduling.view || item.type !== 'missing_daily')).map(row => dto.pick(row, ['id', 'type', 'severity', 'title', 'detail', 'reportId', 'projectId', 'subcontractorId']));
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
    validateWorkspace(context.db);
    try {
      if (req.method === 'GET' && await read(req, res, url)) return true;
      if (await leave(req, res, url) || await review(req, res, url) || await writes(req, res, url) || await daily(req, res, url) || await notes(req, res, url)) return true;
      if (/^\/api\/assignments(?:\/\d+(?:\/acknowledge)?)?$/.test(url.pathname)) {
        const db = h.readDb(), input = await h.body(req), rejection = require('./scheduling-route-guard').guard(db, req.auth.user, req.method, url, input);
        if (rejection) { h.json(res, rejection.status, { error: rejection.error }); return true; }
        const result = await h.run(req, { method: req.method, path: url.pathname + url.search, details: input });
        if (result.response.status >= 400) { h.json(res, result.response.status, { error: result.response.data?.error || 'Schedule unavailable' }); return true; }
        for (const key of new Set([...Object.keys(db), ...Object.keys(result.candidate)])) if (!['assignments'].includes(key) && !equal(db[key], result.candidate[key])) fail(409, 'Unsupported scheduling change');
        validateWorkspace(result.candidate); result.candidate.auditLog ||= []; result.candidate.auditLog.push({ id: crypto.randomUUID(), type: 'schedule_changed', actorId: req.auth.user.id, actor: req.auth.user.name, at: new Date().toISOString() });
        h.writeDb(result.candidate);
        const data = result.response.data;
        h.json(res, result.response.status, data.assignments ? { assignments: data.assignments.map(dto.assignment) } : data.assignment ? { assignment: dto.assignment(data.assignment), ...(data.sourceAssignment !== undefined ? { sourceAssignment: data.sourceAssignment ? dto.assignment(data.sourceAssignment) : null } : {}) } : data.id ? dto.assignment(data) : { ok: true }); return true;
      }
      fail(503, 'Workspace operation is outside this source gate.');
    } catch (error) { if (![400, 401, 402, 403, 404, 409, 503].includes(error.statusCode)) throw error; h.json(res, error.statusCode, { error: error.message }); return true; }
  }
  async function finalize(req,context,url) {
    if(!context.workspaceDeliveryIds?.length)return;
    if(url.pathname!=='/api/workspace-prepare'||!compliance)fail(409,'Unexpected dashboard dependency.');
    let expected={revision:context.savedRevision??context.transactionalRevision,contentHash:canonicalHash(context.candidate??context.openingSnapshot)};
    for(const id of context.workspaceDeliveryIds)expected=await compliance.dispatch(id,expected);
    const loaded=await options.repository.load(options.companyId);
    if(loaded.revision!==expected.revision||loaded.contentHash!==expected.contentHash)fail(409,'Dashboard changed during delivery. Refresh current records.');
    const auth=h.authenticate(req,loaded.snapshot).auth;if(!auth||h.accountAccess(loaded.snapshot.company).locked)fail(401,'Current dashboard access could not be verified.');
    context.finalizedRevision=loaded.revision;context.finalizedContentHash=loaded.contentHash;context.response.data={ok:true};
  }
  return { supported: routes.supported, handle, finalize };
}
module.exports = { createWorkspace };
