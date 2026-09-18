const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supabase = require('./database/supabase');

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
let backupBytes;
global.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/storage/v1/bucket')) return new Response('', { status: 200 });
  if (String(url).includes('/storage/v1/object/tenant-backups/') && options.method === 'POST') { backupBytes = Buffer.from(options.body); return new Response('', { status: 200 }); }
  if (String(url).includes('/storage/v1/object/tenant-backups/')) return new Response(backupBytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (String(url).includes('/rest/v1/companies?select=id,data')) return new Response(JSON.stringify([{ id:'tenant-a',data:{users:[{email:'owner@example.test',status:'Active'}]} }]), { status: 200, headers: { 'Content-Type':'application/json' } });
  if (String(url).includes('/rest/v1/companies?select=data')) return new Response(JSON.stringify([{ data:{company:{id:'tenant-a',name:'Tenant A'},users:[]} }]), { status: 200, headers: { 'Content-Type':'application/json' } });
  throw new Error(`Unexpected Supabase test request: ${url}`);
};
(async()=>{const snapshot={company:{id:'11111111-1111-4111-8111-111111111111',name:'Backup Test'},projects:[{id:1,name:'Project'}]},backup=await supabase.createVerifiedBackup(snapshot);assert.equal(backup.bucket,'tenant-backups');assert.match(backup.hash,/^[a-f0-9]{64}$/);assert.ok(backup.objectKey.startsWith(`${snapshot.company.id}/`));assert.deepEqual(JSON.parse(backupBytes.toString()),snapshot);assert.equal(await supabase.findCompanyByUserEmail('OWNER@example.test'),'tenant-a');assert.equal(await supabase.findCompanyByUserEmail('missing@example.test'),null);assert.equal((await supabase.listCompanySnapshots())[0].company.id,'tenant-a');global.fetch=originalFetch;
if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
if (previousEnabled === undefined) delete process.env.PDL_SUPABASE_ENABLED; else process.env.PDL_SUPABASE_ENABLED = previousEnabled;
fs.rmSync(root, { recursive: true, force: true });
console.log('Supabase adapter tests passed');
})().catch(error=>{global.fetch=originalFetch;console.error(error);process.exitCode=1});
