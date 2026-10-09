'use strict';
// Live schedule chip markup: on-site / done / late / quiet states render the
// expected pill for each of the three schedule views' assignment elements.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8'),lines=source.split('\n');
function code(name){const start=lines.findIndex(l=>l.startsWith(`function ${name}(`));assert.ok(start>=0,name);const line=lines[start];assert.ok(line.trimEnd().endsWith('}'),name+' must be single-line for extraction');return line}
const context={};vm.createContext(context);
vm.runInContext([code('scheduleLiveDuration'),code('scheduleLiveChipMarkup')].join('\n'),context);
const chip=(state,grace)=>context.scheduleLiveChipMarkup(state,{graceMinutes:grace??15});
assert.equal(chip(null),'','missing state renders nothing');
assert.equal(chip({expected:[]}),'','nobody expected renders nothing');
const onSite=chip({expected:[7,8],active:[7],done:[],onSite:[7],elapsedMinutes:75});
assert.ok(onSite.includes('schedule-live-chip on-site'),'on-site variant class');
assert.ok(onSite.includes('On site'),'single active member reads naturally');
assert.ok(onSite.includes('1h 15m'),'elapsed duration formats');
const twoOnSite=chip({expected:[7,8],active:[7,8],done:[],onSite:[7,8],elapsedMinutes:8});
assert.ok(twoOnSite.includes('2 on site'),'count shows for multiple active members');
assert.ok(twoOnSite.includes('8m'),'sub-hour duration formats');
const done=chip({expected:[7],active:[],done:[7],onSite:[7],lateMinutes:500,hours:8.5});
assert.ok(done.includes('schedule-live-chip done'),'done variant class');
assert.ok(done.includes('✓ Done · 8.5h'),'done hours show');
const late=chip({expected:[7,8],active:[],done:[],onSite:[],lateMinutes:25});
assert.ok(late.includes('schedule-live-chip late'),'late variant class');
assert.ok(late.includes('Not on site · 25m late'),'late duration shows');
assert.equal(chip({expected:[7,8],active:[],done:[],onSite:[],lateMinutes:10},15),'','inside the grace period stays quiet');
assert.ok(chip({expected:[7],active:[7],done:[],onSite:[7],elapsedMinutes:130}).includes('2h 10m'),'mixed hour/minute duration formats');
assert.ok(chip({expected:[7],active:[7],done:[],onSite:[7],elapsedMinutes:120}).includes('2h'),'whole-hour duration has no zero minutes');
console.log('Schedule live chips passed: on-site (single/multi, durations), done hours, late vs grace-quiet, empty states (synthetic VM).');
