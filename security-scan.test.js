'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {scan}=require('./scripts/security-scan');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-scan-regression-'));
try{
  const synthetic='sk_live_'+'Q'.repeat(24);
  for(const name of ['a.js','b.js'])fs.writeFileSync(path.join(directory,name),' '.repeat(100)+synthetic);
  fs.writeFileSync(path.join(directory,'safe.js'),"node.textContent = data.name;");
  const result=scan(directory);
  const files=new Set(result.filter(row=>row.type==='Stripe live key').map(row=>row.file));
  assert.equal(files.size,2,'global RegExp state must not skip the next file');
  assert.ok(files.has('a.js')&&files.has('b.js'));
  assert.equal(scan(directory).filter(row=>row.type==='Stripe live key').length,2,'repeat scans must remain deterministic');
  assert.ok(!JSON.stringify(result).includes(synthetic),'scanner output must never disclose the matched value');
  console.log('Secret scanner regression passed: consecutive-file detection, repeatability and redacted findings.');
}finally{fs.rmSync(directory,{recursive:true,force:true})}
