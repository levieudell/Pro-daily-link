'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makePdf, fixtures } = require('./estimate-pdf.test');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-estimate-pdf-'));
Object.assign(process.env, { PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_FOUNDER_ENABLED: '0', PDL_EMAIL_DEV_MODE: '1' });
for (const key of Object.keys(process.env)) if (/^(OPENAI_|STRIPE_|SENTRY_|RESEND_)/.test(key)) delete process.env[key];
const seed = require('./sales-demo-data').buildSalesDemo({ asOf: '2026-10-07' }); seed.estimateImports = []; seed.users=[{id:1,companyId:seed.company.id,name:'Synthetic acceptance owner',role:'owner',status:'Active'}];seed.sessions=[{userId:1,companyId:seed.company.id,tokenHash:require('node:crypto').createHash('sha256').update('estimate-fixture-token').digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString()}];
fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(seed)); fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify({ users: [], sessions: [] }));
const nativeFetch = global.fetch;
global.fetch = (url, ...args) => { assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'No external AI or other provider calls allowed'); return nativeFetch(url, ...args); };
const { server } = require('./server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => { const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json',Authorization:'Bearer estimate-fixture-token' }, body: JSON.stringify(body) } : {headers:{Authorization:'Bearer estimate-fixture-token'}}); return { status: response.status, data: await response.json() }; };
  const items = async () => (await request('/api/state')).data.projects[0].estimateItems;
  const freshApprove=async lines=>{const draft=await request('/api/estimate-imports/analyze',{filename:'synthetic-fresh.pdf',data:'data:application/pdf;base64,'+makePdf(fixtures[0].rows).toString('base64')});return request(`/api/estimate-imports/${draft.data.id}/approve`,{projectId:seed.projects[0].id,lines})};
  try {
    const originalCount = (await items()).length;
    const drafts = [];
    for (const name of ['explicit-unit', 'qty-rate-amount', 'unit-rate-amount-labor']) {
      const fixture = fixtures.find(row => row.name === name);
      const result = await request('/api/estimate-imports/analyze', { filename: name + '.pdf', data: 'data:application/pdf;base64,' + makePdf(fixture.rows).toString('base64') });
      assert.equal(result.status, 201); assert.equal(result.data.extractionMethod, 'embedded_text'); assert.equal(result.data.lines.length, 1); assert.equal(result.data.lines[0].description, 'Concrete slab'); assert.equal(result.data.lines[0].amount, 5000); assert.equal(result.data.reconciled, true); drafts.push(result.data);
    }
    assert.equal(drafts[1].lines[0].unit, ''); assert.ok(drafts[1].reviewWarnings.length);
    const mixed = await request(`/api/estimate-imports/${drafts[1].id}/approve`, { projectId: seed.projects[0].id, lines: [drafts[0].lines[0], drafts[1].lines[0]] });
    assert.equal(mixed.status, 400); assert.match(mixed.data.error, /unit/); assert.equal((await items()).length, originalCount, 'Incomplete review must not partly save or omit a line');
    for (const amount of ['Infinity', -1, {}, 'not-money']) {
      const invalid = await request(`/api/estimate-imports/${drafts[0].id}/approve`, { projectId: seed.projects[0].id, lines: [{...drafts[0].lines[0],amount}] });
      assert.equal(invalid.status,400); assert.match(invalid.data.error,/finite non-negative/); assert.equal((await items()).length,originalCount);
    }
    for (const bad of [{description:{}},{unit:{}},{quantity:'Infinity'}]) {
      const invalid = await request(`/api/estimate-imports/${drafts[0].id}/approve`, { projectId: seed.projects[0].id, lines: [{...drafts[0].lines[0],...bad}] }); assert.equal(invalid.status,400);
    }
    const nullRow=await request(`/api/estimate-imports/${drafts[0].id}/approve`,{projectId:seed.projects[0].id,lines:[null]}); assert.equal(nullRow.status,400);
    const approved = await request(`/api/estimate-imports/${drafts[1].id}/approve`, { projectId: seed.projects[0].id, lines: [{ ...drafts[1].lines[0], description: 'Concrete slab reviewed', unit: 'SF', budgetHours: 16 }] });
    assert.equal(approved.status, 200); assert.equal(approved.data.items[0].plannedQuantity, 100); assert.equal(approved.data.items[0].unit, 'SF'); assert.equal(approved.data.items[0].cost, 5000); assert.equal(approved.data.items[0].budgetHours, 16);
    const countAfterApproval=(await items()).length;const repeated=await request(`/api/estimate-imports/${drafts[1].id}/approve`,{projectId:seed.projects[0].id,lines:[{...drafts[1].lines[0],unit:'SF'}]});assert.equal(repeated.status,409);assert.equal(repeated.data.code,'ESTIMATE_ALREADY_APPROVED');assert.equal((await items()).length,countAfterApproval);
    const concurrentDraft=await request('/api/estimate-imports/analyze',{filename:'synthetic-concurrent.pdf',data:'data:application/pdf;base64,'+makePdf(fixtures[0].rows).toString('base64')});const countBeforeConcurrent=(await items()).length;const concurrent=await Promise.all([1,2].map(()=>request(`/api/estimate-imports/${concurrentDraft.data.id}/approve`,{projectId:seed.projects[0].id,lines:concurrentDraft.data.lines})));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal((await items()).length,countBeforeConcurrent+1);
    const saved = (await items()).find(item => item.sourceImportId === drafts[1].id); assert.deepEqual(saved, approved.data.items[0]);
    assert.match(drafts[2].reviewWarnings.join(' '), /Labor information/); assert.equal(drafts[2].lines[0].budgetHours, null);
    const noHours = await request(`/api/estimate-imports/${drafts[2].id}/approve`, { projectId: seed.projects[0].id, lines: drafts[2].lines }); assert.equal(noHours.status, 200); assert.equal(noHours.data.items[0].budgetHours, null, 'Sales rate and PDF labor annotation must not invent a work budget');
    // Real save/reload boundaries: explicit unknown must not trigger a catalog default.
    const catalog = await request('/api/catalog',{name:'Unknown budget fixture',unit:'SF',targetHoursPerUnit:2});
    const budgetItems=[];
    for(const hours of [null,0,18]){
      const result=await freshApprove([{...drafts[0].lines[0],catalogItemId:catalog.data.id,budgetHours:hours}]);
      assert.equal(result.status,200); assert.equal(result.data.items[0].budgetHours,hours); budgetItems.push(result.data.items[0]);
      assert.equal((await items()).find(item=>item.id===result.data.items[0].id).budgetHours,hours);
    }
    const legacyLine={...drafts[0].lines[0],catalogItemId:catalog.data.id};delete legacyLine.budgetHours;
    const omitted=await freshApprove([legacyLine]); assert.equal(omitted.data.items[0].budgetHours,200,'Legacy omitted field retains catalog calculation');
    const projectId=seed.projects[0].id;
    for(const hours of [null,0,18]){
      const created=await request(`/api/projects/${projectId}/estimate-items`,{name:'Manual hours fixture',plannedQuantity:10,unit:'SF',budgetHours:hours}); assert.equal(created.status,201);assert.equal(created.data.budgetHours,hours);
      const response=await fetch(base+`/api/projects/${projectId}/estimate-items/${created.data.id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer estimate-fixture-token'},body:JSON.stringify({budgetHours:null})});assert.equal(response.status,200);assert.equal((await response.json()).budgetHours,null);
      assert.equal((await items()).find(item=>item.id===created.data.id).budgetHours,null);
    }
    const production=(await request('/api/production')).data.projects.find(row=>row.projectId===projectId).items;
    for(const item of budgetItems){const metric=production.find(row=>row.estimateItemId===item.id);assert.equal(metric.budgetHours,item.budgetHours);assert.equal(metric.laborPercent,item.budgetHours==null?null:0)}
    const fresh=JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE,'utf8')); fresh.reports.push({id:99999,project:0,status:'Approved',dateIso:'2026-10-07',laborEntries:[],productionEntries:budgetItems.map(item=>({estimateItemId:item.id,quantity:10,laborHours:3}))});fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(fresh));
    const insights=(await request('/api/insights')).data.records.filter(row=>row.reportId===99999);
    for(const item of budgetItems)assert.equal(insights.find(row=>row.estimateItemId===item.id).targetHoursPerUnit,item.budgetHours==null?null:item.budgetHours/100);
    const sample = fs.readFileSync(path.join(__dirname,'test-fixtures','estimates','smartsheet-painting-public.pdf'));
    const unsupported = await request('/api/estimate-imports/analyze',{filename:'public-painting.pdf',data:'data:application/pdf;base64,'+sample.toString('base64')}); assert.equal(unsupported.data.lines.length,0); assert.equal(unsupported.data.requiresAiReview,true);
    const scan = fs.readFileSync(path.join(__dirname,'test-fixtures','estimates','synthetic-scanned-estimate.pdf'));
    const scanResult = await request('/api/estimate-imports/analyze',{filename:'synthetic-scan.pdf',data:'data:application/pdf;base64,'+scan.toString('base64')}); assert.equal(scanResult.data.requiresOcr,true);
    // Mocked transport checks request contract and fallback wiring only, NOT OCR accuracy.
    let providerBody, providerCalls = 0;
    process.env.OPENAI_API_KEY='synthetic-provider-fixture';
    global.fetch = (url,...args) => {
      if (String(url)==='https://api.openai.com/v1/responses') { providerCalls++; providerBody=JSON.parse(args[0].body); return Promise.resolve({ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify(require('./test-fixtures/estimates/smartsheet-painting-oracle'))}]}]})}); }
      assert.equal(new URL(String(url)).hostname,'127.0.0.1'); return nativeFetch(url,...args);
    };
    const assisted = await request('/api/estimate-imports/analyze',{filename:'public-painting-mocked.pdf',data:'data:application/pdf;base64,'+sample.toString('base64')});
    assert.equal(providerCalls,1); assert.equal(assisted.data.extractionMethod,'ai_ocr'); assert.equal(assisted.data.lines.length,13); assert.equal(assisted.data.lineTotal,5133); assert.equal(assisted.data.lines.reduce((sum,line)=>sum+(line.budgetHours||0),0),70); assert.equal(providerBody.store,false); assert.match(providerBody.instructions,/SELLING/); assert.ok(providerBody.text.format.schema.properties.lines.items.required.includes('budgetHours'));
    const laborLine=assisted.data.lines.find(line=>line.description==='Wall painting');
    const savedLabor=await request(`/api/estimate-imports/${assisted.data.id}/approve`,{projectId:seed.projects[0].id,lines:[laborLine]}); assert.equal(savedLabor.status,200); assert.equal(savedLabor.data.items[0].budgetHours,18); assert.equal(savedLabor.data.items[0].cost,900);
    delete process.env.OPENAI_API_KEY;
    const unknownAmount = await freshApprove([{...drafts[0].lines[0],amount:null}]); assert.equal(unknownAmount.status,200); assert.equal(unknownAmount.data.items[0].cost,null); assert.equal((await items()).find(item=>item.id===unknownAmount.data.items[0].id).cost,null);
    const incompletePdf=makePdf(fixtures.find(row=>row.name==='qty-rate-amount').rows);
    const fieldIncomplete=await request(`/api/projects/${seed.projects[0].id}/estimate-proposals`,{filename:'missing-unit.pdf',data:'data:application/pdf;base64,'+incompletePdf.toString('base64')}); assert.equal(fieldIncomplete.status,400); assert.match(fieldIncomplete.data.error,/unit review/);
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'); assert.match(source, /d\.reviewWarnings\.map\(warning=>`<p>\$\{escapeHtml\(warning\)\}/); assert.match(source, /aria-label="Unit" placeholder="Enter unit"/);
    assert.match(source,/data-import-include/); assert.match(source,/line\.scopeStatus!=='uncertain'\?'checked':''/); assert.match(source,/Selling line amount/); assert.match(source,/Printed selling unit rate/); assert.match(source,/Printed internal\/builder cost/);
    assert.match(source,/line\.budgetHours!=null\?'1':'0'/); assert.match(source,/line\.budgetHoursUserEdited=explicitHours/);
    console.log('Estimate PDF API: local extraction/save, finite atomic validation, scan/public-sample limitations, mocked assisted contract and explicit-hours persistence passed; no provider accuracy claim');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); global.fetch = nativeFetch; fs.rmSync(temp, { recursive: true, force: true }); }
});
