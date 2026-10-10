'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
function code(name){const lines=source.split('\n'),start=lines.findIndex(line=>line.startsWith(`function ${name}(`)||line.startsWith(`async function ${name}(`));assert.ok(start>=0,name);if(lines[start].trimEnd().endsWith('}'))return lines[start];const end=lines.findIndex((line,index)=>index>start&&line.trimEnd()==='}');assert.ok(end>start,name);return lines.slice(start,end+1).join('\n')}
const classes=()=>({add(){},remove(){},toggle(){},contains(){return false}});
const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,innerHTML:'',textContent:'',classList:classes()});return nodes.get(id)};
const block={dataset:{assignment:'7',member:'1'},classList:classes()};
const row={id:7,projectId:1,date:'2026-10-10',memberIds:[1],start:'07:00',end:'15:00',activity:'Synthetic work',crew:'QA'};
let selected=false,touchOptions,calls=[];
const context={
 $:node,$$:selector=>selector==='[data-assignment]'?[block]:[],document:{addEventListener(){}},
 currentRole:'office',currentUser:{id:1,role:'project_manager',permissions:{scheduleCrews:true}},
 window:{pdlWorkspaceActions:{enabled:()=>selected},PDLScheduleAvailability:require('./schedule-availability'),PDLScheduleApprovedLabor:require('./schedule-approved-labor')},
 scheduleView:'day',scheduleAnchorDate:'2026-10-10',preferredLanguage:'en',scheduleAvailability:[],scheduleAvailabilityStatus:'ready',scheduleTouchDragAttached:false,
 PDLScheduleTouchDrag:{attach(root,options){touchOptions=options}},draggedScheduleWork:null,
 team:[{id:1,name:'Synthetic worker',initials:'SW',role:'Worker',crew:'QA'}],projects:[{id:1,name:'Synthetic project',code:'QA'}],reports:[],assignments:[row],
 localDateIso:()=> '2026-10-10',formatDate:value=>value,displayTime:value=>value,escapeHtml:value=>String(value),interfaceLocale:()=> 'en-US',
 renderMyDay(){},notify(){},api:async(route,options)=>{calls.push({route,options});return route==='/api/state'?{assignments:[row]}:{assignment:row}}
};
vm.createContext(context);
for(const name of ['canManageSchedule','canMoveScheduledWork','isOfficeMember','shiftHours','scheduleDate','scheduleWeekStart','schedulePeriodDays','scheduleUnavailable','timeOffHoursLabel','scheduleLeaveRanges','scheduleLeaveConflict','scheduleLeaveMarkup','scheduleDayLeaveMarkup','scheduleUnavailableSummary','scheduleMobileMarkup','renderSchedule','moveScheduledWork'])vm.runInContext(code(name),context);
const grant=edit=>{context.currentUser.effectiveCapabilities={scheduling:{view:true,create:true,edit,approve:true}}};
(async()=>{
 // The inherited ordinary UI keeps its stored-grant behavior when the typed boundary is absent.
 context.renderSchedule();assert.equal(context.canMoveScheduledWork(),true);assert.match(node('#schedule-board').innerHTML,/draggable="true"/);assert.equal(touchOptions.canManage(),true);
 context.currentUser.permissions.scheduleCrews=false;assert.equal(context.canMoveScheduledWork(),false);context.currentUser.permissions.scheduleCrews=true;
 selected=true;grant(false);context.renderSchedule();assert.equal(touchOptions.canManage(),false,'a read-only profile cannot start a touch gesture');assert.match(node('#schedule-board').innerHTML,/draggable="false"/);
 let prevented=0;block.ondragstart({preventDefault(){prevented++},dataTransfer:{}});assert.equal(prevented,1);assert.equal(context.draggedScheduleWork,null);
 await touchOptions.onMove({assignmentId:7,memberId:1,targetMemberId:2,date:'2026-10-11'});assert.equal(calls.length,0,'a direct denied touch callback cannot open a write preview');
 grant(true);context.renderSchedule();assert.equal(touchOptions.canManage(),true);assert.match(node('#schedule-board').innerHTML,/draggable="true"/);
 const event={preventDefault(){prevented++},dataTransfer:{}};block.ondragstart(event);assert.equal(event.dataTransfer.effectAllowed,'move');
 // Check current eligibility at drop, after a native gesture has already started.
 grant(false);await context.moveScheduledWork(2,'2026-10-11');assert.equal(calls.length,0);
 grant(true);assert.equal(touchOptions.canManage(),true);delete context.currentUser.effectiveCapabilities;assert.equal(touchOptions.canManage(),false,'missing effective DTO fails closed');grant(true);
 for(const role of ['field','foreman','crew','platform_owner']){context.currentUser.role=role;assert.equal(context.canMoveScheduledWork(),false,'typed edit cannot broaden fixed role eligibility')}
 context.currentUser.role='project_manager';context.currentUser.permissions.scheduleCrews=false;assert.equal(context.canMoveScheduledWork(),false);context.currentUser.permissions.scheduleCrews=true;
 context.currentRole='field';assert.equal(context.canMoveScheduledWork(),false);context.currentRole='office';
 await context.moveScheduledWork(2,'2026-10-11');assert.equal(calls.length,2);assert.equal(calls[0].route,'/api/assignments/7');assert.equal(calls[0].options.method,'PATCH');assert.deepEqual(JSON.parse(calls[0].options.body),{memberId:1,targetMemberId:2,date:'2026-10-11'});assert.equal(calls[1].route,'/api/state');
 context.currentUser={id:2,role:'owner',effectiveCapabilities:{scheduling:{edit:true}}};assert.equal(context.canMoveScheduledWork(),true);
 console.log('Scheduling gesture permission regression passed: inherited defaults, typed denial, native/touch wiring, current DTO revocation and fixed role ceiling.');
})().catch(error=>{console.error(error);process.exitCode=1});
