'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-compat-workspace-'));
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  const file = path.join(directory, 'legacy.json'), legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B; fs.writeFileSync(file, JSON.stringify(legacy)); const oldBytes = fs.readFileSync(file);
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port, seed = snapshot(); seed.company.features = { timeCards: true, templates: true }; seed.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  seed.projects[0].estimateItems = [{ id: 1, name: 'Synthetic wall tile', unit: 'SF', plannedQuantity: 100, budgetHours: 10, cost: 500 }];
  seed.team.push({ id: 12, name: 'Synthetic Field', crew: 'Synthetic Crew', role: 'Foreman', email: 'field@example.invalid' });
  seed.users.push({ id: 2, companyId: A, memberId: 12, name: 'Synthetic Field', email: 'field@example.invalid', status: 'Active', role: 'field', ...credential(initial), projectIds: [], assignedCrews: [], permissions: {} });
  seed.assignments.push({ id: 1, projectId: 101, memberIds: [12], crew: 'Synthetic Crew', date: '2026-10-09', start: '08:00', end: '16:00', activity: 'Synthetic tile', acknowledgements: {}, notifications: {} });
  seed.reports.push({ id: 1, project: 0, dateIso: '2026-10-09', date: 'Oct 9', foreman: 'Synthetic Field', sourceAssignmentId: 1, crew: 'Synthetic Crew', status: 'Approved', notes: 'Synthetic completed work', productionEntries: [{ estimateItemId: 1, quantity: 10, unit: 'SF', laborHours: 2 }], laborEntries: [{ memberId: 12, hours: 2, crew: 'Synthetic Crew' }], flags: [], history: [], rateSnapshot: { schemaVersion: 1, laborRate: 50, source: 'first-approval', capturedAt: new Date().toISOString(), capturedBy: { id: 1, name: 'Synthetic Owner', role: 'owner' } } });
  seed.hiddenPrivate = { mustNeverReturn: 'synthetic-private-sentinel' }; seed.company.privateProviderData = { secret: 'synthetic-private-sentinel' }; seed.projects[0].privateProviderData = 'synthetic-private-sentinel';
  const store = memory(seed), key = crypto.randomBytes(32), fixture = services(store, origin, { key });
  const deliveries=[];
  const uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key,complianceSend:async(source)=>{deliveries.push(source);return {status:'accepted'};} });
  const rawRequest = async (route, { method = 'GET', data, token, tenant = A } = {}) => { const response = await fetch(origin + route, { method, headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return { status: response.status, value, response }; };
  const request=async(route,options={})=>{const definition=require('./workspace-direct-admission').route(options.method,route);if(!definition||options.data?.token)return rawRequest(route,options);const preview=await rawRequest('/api/workspace-direct-preview',{...options,method:'POST',data:{family:definition.family,method:options.method,path:route,details:options.data||{}}});if(preview.status!==200)return preview;return rawRequest(route,{...options,data:{token:preview.value.token,version:preview.value.version,confirmed:true,requestId:crypto.randomUUID()}});};
  try {
    assert.equal((await request('/api/state')).status, 401);
    const login = await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: initial } }); assert.equal(login.status, 200); const token = login.value.token;
    const state = await request('/api/state', { token }); assert.equal(state.status, 200, JSON.stringify(state.value)); assert.equal(JSON.stringify(state.value).includes('synthetic-private-sentinel'), false); assert.equal(state.value.reports[0].sourceAssignmentId, 1); assert.deepEqual(state.value.assignments[0].acknowledgements, {}); assert.equal(state.value.reports[0].rateSnapshot.capturedBy.id, 1);
    for (const route of ['/api/production', '/api/action-center', '/api/insights', '/api/exceptions', '/api/audit-log', '/api/catalog', '/api/daily-templates', '/api/time-cards', '/api/schedule-availability', '/api/time-off-requests', '/api/company-activities', '/api/pay-periods', '/api/billing']) { const result = await request(route, { token }); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.value)); }
    assert.equal((await request('/api/state', { token, tenant: B })).status, 404);
    assert.equal((await request('/api/projects', { token, method: 'POST', data: { name: 'Must be fenced' } })).status, 503);
    const p = await request('/api/time-cards/action-preview', { token, method: 'POST', data: { action: 'create', details: { memberId: 12, projectId: 101, inAt: '2026-10-09T08:00:00Z', outAt: '2026-10-09T10:00:00Z', reason: 'Synthetic manual time' } } }); assert.equal(p.status, 200, JSON.stringify(p.value));
    const proof = { token: p.value.token, version: p.value.version, confirmed: true, requestId: crypto.randomUUID() }, confirm = await request('/api/time-cards', { token, method: 'POST', data: proof }); assert.equal(confirm.status, 201, JSON.stringify(confirm.value)); const id = confirm.value.id;
    assert.equal((await request('/api/time-cards', { token, method: 'POST', data: proof })).status, 200); assert.equal(store.current().timeCards.length, 1);
    const submit = await request('/api/time-cards/action-preview', { token, method: 'POST', data: { action: 'submit', id, details: {} } }); assert.equal(submit.status, 200, JSON.stringify(submit.value));
    assert.equal((await request('/api/time-cards/' + id + '/submit', { token, method: 'POST', data: { token: submit.value.token, version: submit.value.version, confirmed: true, requestId: crypto.randomUUID() } })).status, 200);
    const approve = await request('/api/time-cards/review-preview', { token, method: 'POST', data: { decision: 'approve', ids: [id] } }); assert.equal(approve.status, 200, JSON.stringify(approve.value));
    assert.equal((await request('/api/time-cards/' + id + '/approve', { token, method: 'POST', data: { token: approve.value.token, version: approve.value.version, confirmed: true, requestId: crypto.randomUUID() } })).status, 200);
    async function action(previewPath, action, details, method, path, recordId) { const preview=await request(previewPath,{token,method:'POST',data:{action,...(recordId?{id:recordId}:{}),details}});assert.equal(preview.status,200,action+': '+JSON.stringify(preview.value));const result=await request(path,{token,method,data:{token:preview.value.token,version:preview.value.version,confirmed:true,requestId:crypto.randomUUID()}});assert.ok([200,201].includes(result.status),action+': '+JSON.stringify(result.value));return result.value; }
    const report=await action('/api/daily-actions/preview','createReport',{projectId:101,sourceAssignmentId:1,crew:'Synthetic Crew',dateIso:'2026-10-09',status:'Needs review',notes:'Synthetic second tile shift',signature:'Synthetic Field',foreman:'Synthetic Field',productionEntries:[{estimateItemId:1,description:'Synthetic wall tile',quantity:5,unit:'SF',laborHours:1}],laborEntries:[{memberId:12,hours:1,crew:'Synthetic Crew'}]},'POST','/api/reports');
    assert.equal(report.sourceAssignmentId,1);
    await action('/api/daily-actions/preview','editReport',{notes:'Synthetic reviewed second tile shift',sourceAssignmentId:1},'PATCH','/api/reports/'+report.id,report.id);
    await action('/api/daily-actions/preview','approveReport',{},'PATCH','/api/reports/'+report.id+'/approve',report.id);
    const period=await action('/api/pay-periods/action-preview','createPeriod',{label:'Synthetic October',from:'2026-10-01',to:'2026-10-31'},'POST','/api/pay-periods');
    await action('/api/pay-periods/action-preview','editPeriod',{label:'Synthetic October reviewed',from:'2026-10-01',to:'2026-10-31',reason:'Synthetic owner review'},'PATCH','/api/pay-periods/'+period.id,period.id);
    assert.equal((await request('/api/pay-periods/'+period.id+'/summary',{token})).status,200);
    const exportRecord=await action('/api/pay-periods/action-preview','captureExport',{},'POST','/api/pay-periods/'+period.id+'/exports',period.id);
    assert.equal((await request('/api/pay-periods/'+period.id+'/exports/'+exportRecord.id+'.csv',{token})).status,200);
    const note=await request('/api/projects/101/notes-todos',{token,method:'POST',data:{kind:'todo',text:'Synthetic team-visible follow-up',dueDate:'2026-10-20',requestId:crypto.randomUUID()}});assert.equal(note.status,201,JSON.stringify(note.value));
    const noteUpdate=await request('/api/projects/101/notes-todos/'+note.value.id,{token,method:'PATCH',data:{revision:note.value.revision,text:'Synthetic updated follow-up',completed:true}});assert.equal(noteUpdate.status,200,JSON.stringify(noteUpdate.value));
    assert.equal((await request('/api/projects/101/notes-todos',{token})).status,200);
    const fieldLogin=await request('/api/auth/login',{method:'POST',data:{email:'field@example.invalid',password:initial}});assert.equal(fieldLogin.status,200);const fieldToken=fieldLogin.value.token;
    const leave=await request('/api/time-off-requests',{token:fieldToken,method:'POST',data:{startDate:'2026-10-20',endDate:'2026-10-20',allDay:true,type:'vacation',note:'Synthetic private note',requestId:crypto.randomUUID()}});assert.equal(leave.status,201,JSON.stringify(leave.value));
    const reviewLeave=await request('/api/time-off-requests/'+leave.value.id+'/review-preview',{token,method:'POST',data:{decision:'approve',note:'Synthetic office approved'}});assert.equal(reviewLeave.status,200);
    assert.equal(reviewLeave.value.token.startsWith('v2.'),true);assert.equal(Buffer.from(reviewLeave.value.token.split('.')[2],'base64url').toString().includes('Synthetic office approved'),false);
    assert.equal((await request('/api/time-off-requests/'+leave.value.id+'/approve',{token,method:'POST',data:{token:reviewLeave.value.token,version:reviewLeave.value.version,confirmed:true,requestId:crypto.randomUUID()}})).status,200);
    const availability=await request('/api/schedule-availability',{token:fieldToken});assert.equal(availability.status,200);assert.equal(JSON.stringify(availability.value).includes('Synthetic private note'),false);
    assert.equal((await request('/api/billing',{token:fieldToken})).status,403);
    assert.equal((await request('/api/state?memberId=11',{token:fieldToken})).status,403);
    const acknowledged=await request('/api/assignments/1/acknowledge',{token:fieldToken,method:'POST',data:{}});assert.equal(acknowledged.status,200,JSON.stringify(acknowledged.value));assert.equal(acknowledged.value.acknowledgements['12'].status,'acknowledged');
    async function mutate(change){const loaded=await store.load(A);change(loaded.snapshot);await store.commit(loaded.snapshot,loaded.revision);}
    await mutate(db=>{db.subcontractors.push({id:51,companyId:A,name:'Synthetic Subcontractor',contact:'Synthetic Contact',email:'synthetic@example.invalid',autoComplianceReminders:true});});
    const prepared=await request('/api/workspace-prepare',{token});assert.equal(prepared.status,200,JSON.stringify(prepared.value));assert.equal(Number(prepared.response.headers.get('X-PDL-Workspace-Revision')),store.revision());assert.equal(deliveries.length,1);assert.equal(store.current().workspaceComplianceJobs[0].status,'sent');await request('/api/workspace-prepare',{token});assert.equal(deliveries.length,1);
    const clean=store.current();await mutate(db=>{db.team.find(row=>row.id===12).crew=['Synthetic Crew'];});
    for(const path of ['/api/state','/api/time-cards','/api/reports/1','/api/projects/101/notes-todos'])assert.equal((await request(path,{token})).status,409,path);
    await mutate(db=>{db.team=clean.team;db.timeCards[0].history.push({action:'Synthetic malformed history',reason:{private:'synthetic-private-sentinel'}});});
    for(const path of ['/api/time-cards','/api/time-cards.csv']){const result=await request(path,{token});assert.equal(result.status,409,path);assert.equal(JSON.stringify(result.value).includes('synthetic-private-sentinel'),false);}
    await mutate(db=>{db.timeCards=clean.timeCards;db.company.stripeSubscriptionId='sub_synthetic_boundary';});assert.equal((await request('/api/billing',{token})).status,503);
    assert.deepEqual(fs.readFileSync(file), oldBytes); console.log('workspace integration: finite bootstrap/dashboard and create/submit/approve/replay passed; legacy bytes unchanged');
  } finally { uninstall(); await new Promise(resolve => mod.server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
