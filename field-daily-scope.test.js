'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const scope=require('./field-daily-scope');
const {propose}=require('./daily-work-extraction');

for(const raw of ['yd','yds','yard','yards','yardas','cy','cubic yard','cubic yards'])assert.equal(scope.normalizeUnit(raw),'CY',raw);
assert.equal(scope.normalizeUnit('sq ft'),'SF');
assert.equal(scope.normalizeUnit('linear feet'),'LF');
assert.equal(scope.normalizeUnit('each'),'EA');

const estimate=[{id:1,name:'Foundation concrete',unit:'CY',plannedQuantity:180,budgetHours:48},{id:2,name:'Slab on grade',unit:'SF',plannedQuantity:4200,budgetHours:160}];
const poured=propose('Poured 12 yards of foundation concrete.')[0];
assert.equal(poured.quantity,12);
assert.equal(scope.normalizeUnit(poured.unit),'CY');
const matched=scope.reviewScope({productions:[poured],estimateItems:estimate,approvedQuantities:{1:100},crewHours:0});
assert.equal(matched.lines.length,1);
assert.equal(matched.lines[0].estimateItemId,1);
assert.equal(matched.lines[0].unit,'CY','the estimate line supplies the unit');
assert.equal(matched.lines[0].quantity,12);
assert.equal(matched.flags.length,0,'100 approved plus 12 is inside 5% of 180');

const bare=propose('Poured 12 yards.')[0];
const byUnit=scope.reviewScope({productions:[bare],estimateItems:estimate,approvedQuantities:{},crewHours:0});
assert.equal(byUnit.lines[0].estimateItemId,1,'a single estimate line with that unit is the match');
assert.equal(byUnit.lines[0].unit,'CY');

const over=scope.reviewScope({productions:[{description:'Poured 20 yards of foundation concrete.',quantity:20,unit:'yards'}],estimateItems:estimate,approvedQuantities:{1:170},crewHours:0});
assert.equal(over.lines.length,1);
assert.equal(over.flags.filter(flag=>flag.reason==='over_quantity').length,1,'170 plus 20 exceeds 180 by more than 5%');
assert.equal(over.flags[0].createsChange,false,'the check does not create a change');

const washout=scope.reviewScope({productions:[{description:'Installed a temporary pump washout pad.',quantity:1,unit:'EA'}],estimateItems:estimate,approvedQuantities:{},crewHours:0});
assert.equal(washout.lines.length,0,'unmatched work is not invented as an estimate line');
assert.equal(washout.flags[0].reason,'no_match');
assert.equal(washout.flags[0].kind,'extra');
assert.equal(washout.flags[0].createsChange,false);
assert.match(washout.unmatchedNotes[0],/washout/);

const slow=scope.reviewScope({productions:[poured],estimateItems:estimate,approvedQuantities:{},crewHours:24});
const productivity=slow.flags.find(flag=>flag.kind==='productivity');
assert.ok(productivity,'hours far over the budget rate are flagged');
assert.equal(productivity.createsChange,false);
assert.equal(scope.decideFlag(productivity,'extra').createsChange,false,'a productivity flag is never a change order');
assert.equal(scope.decideFlag(productivity,'extra').decision,'noted');

const extra=scope.decideFlag(washout.flags[0],'yes');
assert.equal(extra.extra_work,true);
assert.equal(extra.createsChange,false,'the field does not decide billability');
assert.equal(scope.decideFlag(washout.flags[0],'no').decision,'not');
assert.equal(scope.decideFlag(washout.flags[0],'estimate').createsChange,false);
assert.equal(scope.confirmedExtraChanges(washout.flags).length,0,'unanswered flags do not create changes');
assert.equal(scope.confirmedExtraChanges([extra]).length,0,'a field yes is not a billable change');
const stored=scope.fieldExtraItems([{...extra,who_asked:'owner'}]);
assert.equal(stored.length,1);
assert.equal(stored[0].extra_work,true);
assert.equal(stored[0].who_asked,'owner');
assert.equal(Object.hasOwn(stored[0],'billable'),false);
assert.equal(scope.confirmedExtraChanges([productivity]).length,0);

const clock=scope.hoursFromClock({cards:[{projectId:1,date:'2026-10-16',memberId:3,inAt:'2026-10-16T14:00:00.000Z',outAt:'2026-10-16T21:30:00.000Z',hours:7.5},{projectId:1,date:'2026-10-16',memberId:4,inAt:'2026-10-16T14:00:00.000Z',outAt:null,hours:null},{deletedAt:'2026-10-16T22:00:00.000Z',projectId:1,date:'2026-10-16',memberId:5,inAt:'a',outAt:'b',hours:8}],projectId:1,date:'2026-10-16',scheduled:[{memberId:3,hours:8.5,source:'schedule'}]});
assert.equal(clock.source,'clock');
assert.deepEqual(clock.laborEntries,[{memberId:3,hours:7.5,source:'clock'}]);
assert.equal(clock.scheduledIgnored,true);
const none=scope.hoursFromClock({cards:[],projectId:1,date:'2026-10-16',scheduled:[{memberId:3,hours:8.5,source:'schedule'}]});
assert.equal(none.source,'none');
assert.deepEqual(none.laborEntries,[]);
assert.equal(none.scheduledIgnored,true);

for(const requested of ['Approved','Needs review','Submitted','',null])assert.equal(scope.submissionStatus(requested),'Needs review',String(requested));
assert.equal(scope.submissionStatus('Draft'),'Draft');
assert.equal(scope.mergedNext('Form the east side.', ''), 'Form the east side.');
assert.equal(scope.mergedNext('Form the east side.', '   '), 'Form the east side.');
assert.equal(scope.mergedNext('', '  Stage the pump truck Monday.  '), 'Stage the pump truck Monday.');
assert.equal(scope.mergedNext('Short next.', 'Finish the east curb and leave the forms up.'), 'Finish the east curb and leave the forms up.');
assert.equal(scope.mergedNext('Finish the east curb and leave the forms up.', 'Short next.'), 'Short next.');
assert.equal(scope.mergedNext('Same length.', 'Same length!'), 'Same length!');
assert.equal(scope.mergedNext('kept', 'x'.repeat(600)).length, 500);

const server=fs.readFileSync(__dirname+'/server.js','utf8'),app=fs.readFileSync(__dirname+'/app.js','utf8');
assert.match(server,/status:fieldScope\.submissionStatus\(input\.status\)/);
assert.match(server,/recordFieldExtras\(/);
const extractHandler=server.slice(server.indexOf("pathname==='/api/ai/extract'"),server.indexOf("pathname==='/api/reports'"));
assert.match(extractHandler,/attachFieldScope\(/);
assert.doesNotMatch(extractHandler,/recordFieldExtras|confirmedExtraChanges/);
assert.match(server,/get\('source'\)==='clock'/);
assert.match(app,/source=clock/);
assert.match(app,/const fieldHours=typeof currentRole!=='undefined'&&currentRole==='field',scheduled=fieldHours\|\|total\?\[\]:scheduledReportLabor/);
assert.match(fs.readFileSync(__dirname+'/index.html','utf8'),/Notes are processed by AI to fill your report\./);
const policy=require('./public-file-policy');
assert.equal(policy.isPublicFile(__dirname, __dirname+'/field-daily-scope.js'), true);
assert.equal(policy.isPublicFile(__dirname, __dirname+'/field-instant-daily.js'), true);

console.log('Field daily scope checks passed.');
