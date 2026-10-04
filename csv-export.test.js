'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const csvCell=require('./csv-cell');
for(const value of ['=1+1','+SUM(A1)','-HYPERLINK("https://example.invalid")','@SUM(A1)','  =1','\t=1','\r=1','\n=1','\uFEFF=1']) {
  assert.ok(csvCell(value).startsWith('"\''),'text formula must be neutralized');
}
assert.equal(csvCell(-12.5),'"-12.5"','numeric negative values retain numeric semantics');
assert.equal(csvCell('ordinary value',{quoteAll:false}),'ordinary value','server exports preserve simple-cell formatting');
assert.equal(csvCell('=1+1',{quoteAll:false}),"'=1+1",'formula protection also applies to minimally quoted server CSV');
assert.equal(csvCell('a,"b"\r\nc'),'"a,""b""\r\nc"');
const app=fs.readFileSync('app.js','utf8');
const ticketFunction=app.split('\n').find(line=>line.startsWith('function ticketCsv('));
let blob;
const context={pdlCsvCell:csvCell,projects:[{id:1,name:'=malicious project'}],ticketLines:ticket=>ticket.lines,
  Blob:class{constructor(parts){blob=parts.join('')}},URL:{createObjectURL:()=> 'blob:qa',revokeObjectURL:()=>{}},
  document:{createElement:()=>({click(){}})}};
vm.createContext(context);vm.runInContext(fs.readFileSync('csv-cell.js','utf8'),context);
vm.runInContext(ticketFunction,context);
context.ticketCsv([{projectId:1,vendor:'=1+1',ticketNumber:'QA',ticketDate:'2026-10-04',status:'Verified',lines:[{material:'Concrete',quantity:2,unit:'CY'},{material:'Steel',quantity:3,unit:'EA'}]}]);
assert.equal(blob.split('\r\n').length,3,'one header and two actual rows');
assert.ok(!blob.includes('\\n'),'CSV must not contain literal backslash-n separators');
assert.ok(blob.includes('"\'=malicious project"'));assert.ok(blob.includes('"\'=1+1"'));
for(const name of ['exportOverviewSummary','exportInsights']) {
  const start=app.indexOf(`function ${name}(`),end=app.indexOf('\nfunction ',start+1);
  assert.ok(app.slice(start,end).includes('pdlCsvCell'),name+' must use shared formula protection');
}
console.log('CSV export tests passed: formula protection, numeric preservation, quoted newlines and actual ticket row separators.');
