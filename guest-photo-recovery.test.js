'use strict';
// Local synthetic fixture only. All provider calls are trapped in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSalesDemo } = require('./sales-demo-data');
const { createPortableBackup, collectStorageReferences, digest } = require('./database/portable-backup');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-guest-recovery-'));
const dbFile = path.join(temp, 'db.json');
const db = buildSalesDemo();
const token = 'a'.repeat(48);
const session = 'synthetic-recovery-owner';
const localOnly = process.argv.includes('--local-only');
db.users = [{id:1,companyId:db.company.id,name:'Synthetic owner',email:'owner@example.invalid',role:'owner',status:'Active'}, {id:2,companyId:db.company.id,name:'Unassigned field',email:'field@example.invalid',role:'field',status:'Active',memberId:999}];
db.sessions = db.users.map(user=>({userId:user.id,companyId:db.company.id,tokenHash:digest(Buffer.from(user.id===1?session:'synthetic-unassigned-field')),expiresAt:'2099-01-01T00:00:00Z'}));
db.subcontractors = [{id:1,name:'Synthetic contractor',status:'Active'}];
db.subcontractorLinks = [{id:1,tokenHash:digest(Buffer.from(token)),subcontractorId:1,projectId:db.projects[0].id,status:'Active',expiresAt:'2099-01-01T00:00:00Z'}];
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(temp,'platform.json'), JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_TRANSACTIONAL_DB:'off',PDL_SUPABASE_ENABLED:localOnly?'0':'1',SUPABASE_URL:'https://synthetic-recovery.invalid',SUPABASE_SECRET_KEY:'synthetic-not-a-secret',SENTRY_DSN:'',RESEND_API_KEY:'',OPENAI_API_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:''});
const objects = new Map();
let failPhotoUpload = false;
const nativeFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if(url.hostname === '127.0.0.1') return nativeFetch(input, options);
  assert.equal(url.origin,'https://synthetic-recovery.invalid','No external network is allowed');
  const method=options.method || 'GET';
  if(url.pathname === '/storage/v1/bucket') return new Response('{}');
  if(url.pathname === '/rest/v1/companies') return new Response(JSON.stringify(method==='GET'?[{id:db.company.id,data:JSON.parse(fs.readFileSync(dbFile,'utf8'))}]:[]));
  if(url.pathname.startsWith('/storage/v1/object/')) {
    const key=decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
    if(method==='POST'&&key.startsWith('project-photos/')&&failPhotoUpload)return new Response('Synthetic unavailable storage',{status:503});
    if(method==='POST'){objects.set(key,{bytes:Buffer.from(options.body),type:options.headers['Content-Type']});return new Response('{}');}
    const object=objects.get(key); return object ? new Response(object.bytes,{headers:{'content-type':object.type}}) : new Response('Missing synthetic object',{status:404});
  }
  throw new Error('Unexpected synthetic request: '+method+' '+url.pathname);
};
const { server } = require('./server');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7n8AAAAASUVORK5CYII=','base64');
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let localPhoto;
  try {
    const submit=()=>fetch(base+'/api/guest/'+token+'?c='+db.company.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:'Synthetic recovery test',startedAt:'2026-10-05T15:00:00Z',endedAt:'2026-10-05T16:00:00Z',files:[{name:'synthetic.png',type:'image/png',data:'data:image/png;base64,'+png.toString('base64')}],tickets:[]})});
    if(!localOnly){
      failPhotoUpload=true;
      assert.equal((await submit()).status,500,'A failed private upload must not claim success');
      assert.equal(JSON.parse(fs.readFileSync(dbFile,'utf8')).reports.length,60,'Failed upload leaves original report records intact');
      assert.equal(JSON.parse(fs.readFileSync(dbFile,'utf8')).photos.length,0);
      failPhotoUpload=false;
    }
    const response=await submit();
    assert.equal(response.status,201,await response.text());
    // Wait for the existing tenant queue by making a second request.
    const stateResponse=await fetch(base+'/api/state',{headers:{Authorization:'Bearer '+session,'X-PDL-Company':db.company.id}});
    assert.equal(stateResponse.status,200);
    const stored=JSON.parse(fs.readFileSync(dbFile,'utf8'));
    assert.equal(stored.photos.length,1);
    const photo=stored.photos[0];
    if(photo.url.startsWith('/uploads/'))localPhoto=path.join(__dirname,photo.url.slice(1));
    if(localOnly){
      assert.ok(localPhoto&&fs.existsSync(localPhoto));
      await assert.rejects(createPortableBackup({snapshot:stored,destination:path.join(temp,'independent')}),/Incomplete recovery set/);
      assert.ok(fs.existsSync(localPhoto),'Local fallback bytes must remain available for recovery');
    }else{
      const backup=await createPortableBackup({snapshot:stored,destination:path.join(temp,'independent')});
      assert.equal(photo.storageBucket,'project-photos');
      assert.ok(photo.storageKey.startsWith(db.company.id+'/'));
      assert.equal(collectStorageReferences(stored).length,1);
      assert.equal(backup.manifest.objects.length,1);
      assert.equal(backup.manifest.objects[0].sha256,digest(png));
      assert.equal(digest(fs.readFileSync(path.join(backup.directory,backup.manifest.objects[0].filename))),digest(png));
    }
    const owner=await fetch(base+photo.url,{headers:{Authorization:'Bearer '+session,'X-PDL-Company':db.company.id}});
    assert.equal(owner.status,200);assert.equal(digest(Buffer.from(await owner.arrayBuffer())),digest(png));
    assert.equal((await fetch(base+photo.url)).status,401);
    assert.equal((await fetch(base+photo.url,{headers:{Authorization:'Bearer synthetic-unassigned-field','X-PDL-Company':db.company.id}})).status,404);
    console.log(`Guest photo recovery passed (${localOnly?'local fallback + fail-closed backup':'private cloud + hash-verified backup + failed-upload recovery'}): owner read, anonymous and unassigned-field denial.`);
  } finally {
    await new Promise(resolve=>server.close(resolve));global.fetch=nativeFetch;
    if(localPhoto&&fs.existsSync(localPhoto))fs.unlinkSync(localPhoto);
    fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
