'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReportingExport } = require('./reporting-exports');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-export-record-'));
process.env.PDL_DB_FILE = path.join(temp, 'db.json');
process.env.PDL_PLATFORM_FILE = path.join(temp, 'platform.json');
process.env.PDL_REQUIRE_AUTH = '1';
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_TRANSACTIONAL_DB = 'off';
for (const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY']) delete process.env[key];
const db = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
db.company.demo = true;
const actor = { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId: db.company.id };
db.users = [actor, { ...actor, id: 2, role: 'field' }];
db.sessions = db.users.map(user => ({ userId: user.id, companyId: db.company.id, tokenHash: crypto.createHash('sha256').update('qa-export-'+user.id).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }));
db.reports = [
  { id: 1, project: 0, status: 'Approved', dateIso: '2026-10-01', laborEntries: [{hours: 8}], productionEntries: [{estimateItemId:1, quantity:10, unit:'SF'}], history:[{action:'Approved',by:'QA',at:'2026-10-02T00:00:00Z'}] },
  { id: 2, project: 0, status: 'Draft', dateIso: '2026-10-01', laborEntries: [{hours:99}], productionEntries:[] },
  { id: 3, project: 0, status: 'Approved', dateIso: '2026-09-30', laborEntries: [{hours:4}], productionEntries:[] }
];
const filters = {projectId:db.projects[0].id, from:'2026-10-01', to:'2026-10-31'};
assert.throws(() => createReportingExport(db, null, actor), /must be an object/);
assert.throws(() => createReportingExport(db, {...filters,from:'2026-02-30'}, actor), /valid inclusive/);
assert.throws(() => createReportingExport(db, {...filters,status:'Draft'}, actor), /Supported filters/);
assert.throws(() => createReportingExport({...db,reports:[{...db.reports[0],dateIso:null}]},filters,actor), /explicit ISO/);
const initial = createReportingExport(db, filters, actor);
assert.equal(initial.snapshot.totals.laborHours,8);
assert.deepEqual(initial.includedApprovals.map(row=>row.reportId),[1]);
const legacy=structuredClone(initial);delete legacy.version;delete legacy.seriesId;delete legacy.supersedesId;legacy.schemaVersion=1;
const legacyBefore=JSON.stringify(legacy),compatible=createReportingExport({...db,reportingExports:[legacy]}, {...filters,supersedesId:legacy.id,reason:'Reviewed legacy replacement'},actor);
assert.equal(compatible.version,2);assert.equal(compatible.seriesId,legacy.id);assert.equal(JSON.stringify(legacy),legacyBefore,'legacy export metadata is not rewritten');
db.reportingExports=[initial];
const split = splitSnapshot(db);
const rows = split.records.map(row=>({...row,collection:row.collection,data:row.data}));
assert.deepEqual(assembleSnapshot(split.scalarData,rows).reportingExports,[initial],'transactional snapshot preserves record');
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(db));
fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
const {server} = require('./server');
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(route,user=1,body)=>fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer qa-export-'+user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try {
    const invalid=await request('/api/reporting-exports',1,{...filters,from:'2026-02-30'});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/valid inclusive/);
    assert.equal((await request('/api/reporting-exports',2,filters)).status,403);
    assert.equal((await fetch(base+'/api/reporting-exports/'+initial.id)).status,401);
    const created=await request('/api/reporting-exports',1,{...filters,supersedesId:initial.id,reason:'Synthetic second version'});assert.equal(created.status,201);
    const record=await created.json();assert.equal(record.snapshot.totals.laborHours,8);
    const stored=JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE,'utf8'));
    stored.reports[0].laborEntries[0].hours=100;stored.projects[0].tmSettings={defaultLaborRate:999};
    fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(stored));
    const result=await request('/api/reporting-exports/'+record.id);assert.equal(result.status,200);
    assert.deepEqual(await result.json(),record,'saved export does not recompute after source corrections/rate changes');
    assert.equal((await request('/api/reporting-exports/'+record.id,2)).status,403);
    const other=structuredClone(stored),otherId=crypto.randomUUID();other.company.id=otherId;
    other.sessions.forEach(session=>session.companyId=otherId);other.users.forEach(user=>user.companyId=otherId);
    // Even an incorrectly copied record must fail the tenant-identity check.
    fs.mkdirSync(path.join(temp,'tenants'),{recursive:true});fs.writeFileSync(path.join(temp,'tenants',otherId+'.json'),JSON.stringify(other));
    const foreign=await fetch(base+'/api/reporting-exports/'+record.id,{headers:{Authorization:'Bearer qa-export-1','X-PDL-Company':otherId}});
    assert.equal(foreign.status,404,'record cannot be served from another tenant');
    assert.equal((await fetch(base+'/api/reporting-exports/'+record.id,{method:'PATCH',headers:{Authorization:'Bearer qa-export-1'}})).status,404,'no edit operation exists');
    const state=await (await request('/api/state')).json();assert.equal(Object.hasOwn(state,'reportingExports'),false,'export payload is not broadcast in normal workspace');
    const changed=await (await request('/api/reporting-exports',1,{...filters,supersedesId:record.id,reason:'Synthetic source correction'})).json();assert.notEqual(changed.snapshotSha256,record.snapshotSha256,'new captures preserve new evidence under a different ID');
    assert.equal((await request('/api/reporting-exports/'+crypto.randomUUID())).status,404);
    console.log('Reporting export tests passed: approved-only period, persisted immutable capture, owner-only access, changed-source stability and transactional compatibility (local synthetic fixture).');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
