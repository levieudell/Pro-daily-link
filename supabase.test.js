const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supabase = require('./database/supabase');
const backupVerification = require('./database/backup-verification');
const { tenantStorageNamespace } = require('./database/transactional-repository');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-env-'));
fs.writeFileSync(path.join(root, '.env.local'), '\uFEFFSUPABASE_URL=https://example.supabase.co\nSUPABASE_SECRET_KEY=sb_secret_test\n');
const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SECRET_KEY;
const previousEnabled = process.env.PDL_SUPABASE_ENABLED;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.PDL_SUPABASE_ENABLED = '1';
supabase.loadLocalEnv(root);
assert.equal(process.env.SUPABASE_URL, 'https://example.supabase.co');
assert.equal(process.env.SUPABASE_SECRET_KEY, 'sb_secret_test');
assert.equal(supabase.configured(), true);
const originalFetch = global.fetch;
let backupBytes,logoAttempts=0,logoBucketCreated=false,backupUploadUrls=[];
global.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/storage/v1/bucket')) {const input=JSON.parse(options.body||'{}');if(input.id==='company-logos'){logoBucketCreated=input.public===false&&input.file_size_limit===6000000&&input.allowed_mime_types?.includes('image/png');return new Response('',{status:200})}return new Response(JSON.stringify({ statusCode:'409',code:'BucketAlreadyExists',message:'The resource already exists' }), { status: 400 });}
  if (String(url).endsWith('/storage/v1/bucket/tenant-backups')) return new Response(JSON.stringify({id:'tenant-backups',public:false,file_size_limit:25000000,allowed_mime_types:['application/json']}),{status:200,headers:{'content-type':'application/json'}});
  if (String(url).includes('/storage/v1/object/company-logos/') && options.method === 'POST') {logoAttempts++;return logoAttempts===1?new Response(JSON.stringify({statusCode:'404',error:'Bucket not found',message:'Bucket not found',code:'NoSuchBucket'}),{status:400}):new Response('',{status:200})}
  if (String(url).includes('/storage/v1/object/tenant-backups/') && options.method === 'POST') { backupBytes = Buffer.from(options.body);backupUploadUrls.push(String(url)); return new Response('', { status: 200 }); }
  if (String(url).includes('/storage/v1/object/tenant-backups/')) return new Response(backupBytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (String(url).includes('/rest/v1/companies?select=id,data')) return new Response(JSON.stringify([{ id:'tenant-a',data:{users:[{email:'owner@example.test',status:'Active'}]} }]), { status: 200, headers: { 'Content-Type':'application/json' } });
  if (String(url).includes('/rest/v1/companies?select=data')) return new Response(JSON.stringify([{ data:{company:{id:'tenant-a',name:'Tenant A'},users:[]} }]), { status: 200, headers: { 'Content-Type':'application/json' } });
  throw new Error(`Unexpected Supabase test request: ${url}`);
};
(async()=>{const snapshot={company:{id:'11111111-1111-4111-8111-111111111111',name:'Backup Test'},projects:[{id:1,name:'Project'}]},backup=await supabase.createVerifiedBackup(snapshot);assert.equal(backup.bucket,'tenant-backups');assert.match(backup.hash,/^[a-f0-9]{64}$/);assert.ok(backup.objectKey.startsWith(`${snapshot.company.id}/`));assert.deepEqual(JSON.parse(backupBytes.toString()),snapshot);const legacySnapshot={company:{id:'legacy-builder-account',name:'Legacy Backup Test'},projects:[]},legacyBackup=await supabase.createVerifiedBackup(legacySnapshot),legacyNamespace=tenantStorageNamespace(legacySnapshot);assert.ok(legacyBackup.objectKey.startsWith(`${legacyNamespace}/`),'new legacy backups use the canonical tenant storage namespace');assert.equal(legacyBackup.objectKey.startsWith(`${legacySnapshot.company.id}/`),false,'new backups never create another raw-alias prefix');assert.ok(backupUploadUrls.at(-1).includes(`/tenant-backups/${legacyNamespace}/`));assert.deepEqual(JSON.parse(backupBytes.toString()),legacySnapshot);const verificationDirectory=path.join(root,'backup-verification');await backupVerification.createAndRecordVerification(legacySnapshot,{directory:verificationDirectory,createBackup:supabase.createVerifiedBackup});assert.equal(backupVerification.publicStatus(verificationDirectory,legacySnapshot.company.id).fresh,true,'canonical legacy backup paths establish verified backup evidence');await supabase.upload('company-logos','tenant/logo.png',Buffer.from('logo'),'image/png');assert.equal(logoAttempts,2);assert.equal(logoBucketCreated,true);assert.equal(await supabase.findCompanyByUserEmail('OWNER@example.test'),'tenant-a');assert.equal(await supabase.findCompanyByUserEmail('missing@example.test'),null);assert.equal((await supabase.listCompanySnapshots())[0].company.id,'tenant-a');global.fetch=originalFetch;
if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
if (previousEnabled === undefined) delete process.env.PDL_SUPABASE_ENABLED; else process.env.PDL_SUPABASE_ENABLED = previousEnabled;
fs.rmSync(root, { recursive: true, force: true });
console.log('Supabase adapter tests passed');
})().catch(error=>{global.fetch=originalFetch;console.error(error);process.exitCode=1});
