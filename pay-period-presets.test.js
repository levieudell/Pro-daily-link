'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {payPresetRange,payRangePreview,payCalendarDate}=require('./time-approval-controls'),policy=require('./pay-periods');
const range=(preset,options,from,to)=>assert.deepEqual(payPresetRange(preset,options),{from,to});
range('weekly',{start:'2026-03-06'},'2026-03-06','2026-03-12'); // Spring DST.
range('weekly',{start:'2026-10-30'},'2026-10-30','2026-11-05'); // Fall DST.
range('biweekly',{start:'2026-12-25'},'2026-12-25','2027-01-07');
range('weekly',{start:'2028-02-27'},'2028-02-27','2028-03-04');
range('monthly',{month:'2028-02'},'2028-02-01','2028-02-29');
range('monthly',{month:'2026-02'},'2026-02-01','2026-02-28');
range('monthly',{month:'2026-04'},'2026-04-01','2026-04-30');
range('monthly',{month:'2026-12'},'2026-12-01','2026-12-31');
range('semimonthly',{month:'2028-02',cutoff:15,half:'first'},'2028-02-01','2028-02-15');
range('semimonthly',{month:'2028-02',cutoff:15,half:'second'},'2028-02-16','2028-02-29');
range('semimonthly',{month:'2026-01',cutoff:15,half:'second'},'2026-01-16','2026-01-31');
range('semimonthly',{month:'2026-02',cutoff:27,half:'second'},'2026-02-28','2026-02-28');
range('semimonthly',{month:'2026-04',cutoff:10,half:'second'},'2026-04-11','2026-04-30');
range('biweekly',{start:'2028-02-01'},'2028-02-01','2028-02-14');
assert.notDeepEqual(payPresetRange('biweekly',{start:'2028-02-01'}),payPresetRange('semimonthly',{month:'2028-02'}),'calendar halves differ from 14-day ranges');
for(const start of ['',null,'2026-02-29','2026-02-30','2026-13-01','2026-1-01','not-a-date','9999-12-31'])assert.equal(payPresetRange('weekly',{start}),null);
for(const month of ['','2026-13','2026-2','not-a-month'])assert.equal(payPresetRange('monthly',{month}),null);
for(const cutoff of ['',0,28,32,1.5,'abc'])assert.equal(payPresetRange('semimonthly',{month:'2026-02',cutoff}),null);
assert.equal(payPresetRange('semimonthly',{month:'2026-02',half:'unknown'}),null);
assert.equal(payPresetRange('custom',{start:'2026-01-01'}),null);
assert.equal(payCalendarDate('2028-02-29'),true);assert.equal(payCalendarDate('2026-02-29'),false);
assert.equal(payRangePreview('2026-03-06','2026-03-12','America/Los_Angeles'),'2026-03-06 through 2026-03-12 (7 days, inclusive) · America/Los_Angeles');
assert.match(payRangePreview('2026-02-28','2026-02-28','Pacific/Kiritimati'),/1 day, inclusive/);
assert.match(payRangePreview('2026-02-29','2026-03-01','UTC'),/Choose valid/);
assert.match(payRangePreview('2026-10-10','2026-10-09','UTC'),/End date/);
// A browser/host timezone cannot shift date-only arithmetic, including UTC offsets and DST zones.
const script="const h=require('./time-approval-controls');process.stdout.write(JSON.stringify([h.payPresetRange('biweekly',{start:'2026-03-06'}),h.payPresetRange('monthly',{month:'2028-02'}),h.payRangePreview('2026-10-30','2026-11-05','America/Los_Angeles')]))";
let expected;for(const TZ of ['UTC','America/Los_Angeles','America/New_York','Pacific/Kiritimati','Pacific/Pago_Pago']){const result=spawnSync(process.execPath,['-e',script],{cwd:__dirname,env:{...process.env,TZ},encoding:'utf8'});assert.equal(result.status,0,result.stderr);if(expected)assert.equal(result.stdout,expected,TZ);expected=result.stdout}
// Presets supply the same explicit dates to existing policy; no scheduling metadata is persisted.
const db={company:{id:'synthetic-presets',timezone:'America/Los_Angeles'},payPeriods:[],payPeriodExports:[],auditLog:[]},actor={name:'Synthetic owner'};
const first=policy.savePeriod(db,{label:'First half',...payPresetRange('semimonthly',{month:'2028-02',half:'first'})},actor);
const second=policy.savePeriod(db,{label:'Second half',...payPresetRange('semimonthly',{month:'2028-02',half:'second'})},actor);
assert.equal(db.payPeriods.length,2);assert.equal(second.from,'2028-02-16');assert.equal(first.timeZone,'America/Los_Angeles');
assert.throws(()=>policy.savePeriod(db,{from:'2028-02-15',to:'2028-03-01'},actor),/cannot overlap/);
assert.throws(()=>policy.savePeriod(db,{from:'2028-03-02',to:'2028-03-01'},actor),/valid inclusive/);
db.company.timezone='America/New_York';policy.savePeriod(db,{label:'Edited',from:first.from,to:first.to,reason:'Synthetic correction'},actor,first.id);assert.equal(first.timeZone,'America/Los_Angeles','edits retain the timezone snapshot');
db.payPeriodExports.push({periodId:first.id});assert.throws(()=>policy.savePeriod(db,{label:'Locked',from:first.from,to:first.to,reason:'Synthetic locked edit'},actor,first.id),/dates are fixed/);
console.log('Pay-period presets passed: local calendar/DST/offset independence, leap/month/year ends, semimonthly vs biweekly, inclusive adjacent/overlap boundaries, invalid ranges, timezone snapshots and export locks.');
