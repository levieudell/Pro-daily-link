'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const h=require('./scripts/start-acceptance');
const env={PDL_ACCEPTANCE_ANNUAL_STARTER:'test-only',RENDER:'true',RENDER_SERVICE_ID:h.APPROVED_SERVICE,RENDER_EXTERNAL_URL:h.APPROVED_ORIGIN};
test('annual mode binds exact opt-in, service and origin',()=>{
 assert.equal(h.annualFixtureTarget(env),true);
 for(const replacement of [{PDL_ACCEPTANCE_ANNUAL_STARTER:'yes'},{RENDER_SERVICE_ID:'srv-production'},{RENDER_EXTERNAL_URL:'https://app.prodailylink.com'},{RENDER:'false'}])assert.equal(h.annualFixtureTarget({...env,...replacement}),false);
 assert.equal(h.annualFixtureTarget({...env,PDL_ACCEPTANCE_ANNUAL_STARTER:undefined}),false);
});
test('annual mode rejects wrong target and live key before startup',()=>{
 assert.throws(()=>h.validateConfig({...env,RENDER_SERVICE_ID:'srv-production'}),/Annual fixture/);
 assert.throws(()=>h.validateConfig({...env,STRIPE_SECRET_KEY:'sk_live_synthetic'}),/test-mode keys/);
 assert.throws(()=>h.validateConfig({...env,OPENAI_API_KEY:'synthetic'}),/not permitted/);
});
test('annual seed stays private without users, sessions or password and refuses linked storage',()=>{
 const saved={...process.env};Object.assign(process.env,env);
 const dir=fs.mkdtempSync('/tmp/pdl-acceptance-annual-guard-');fs.chmodSync(dir,0o700);
 try{const config={directory:dir,local:false,publicUrl:h.APPROVED_ORIGIN};const file=h.prepareAnnualFixture(config),db=JSON.parse(fs.readFileSync(file));
 assert.equal(db.company.id,'synthetic-pr114-starter');assert.equal(db.company.subscriptionStatus,'Incomplete');assert.equal(db.company.trialEndsAt,null);assert.equal(db.company.annualUpfront.used,false);assert.deepEqual(db.users,[]);assert.deepEqual(db.sessions,[]);assert.equal(fs.statSync(file).mode&0o077,0);
 db.company.subscriptionStatus='Active';fs.writeFileSync(file,JSON.stringify(db));h.prepareAnnualFixture(config);assert.equal(JSON.parse(fs.readFileSync(file)).company.subscriptionStatus,'Active');
 fs.symlinkSync(file,path.join(dir,'linked'));assert.throws(()=>h.prepareAnnualFixture(config),/private, owned/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,saved);}
});
