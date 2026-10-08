'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(__dirname+'/app.js','utf8'),controls=fs.readFileSync(__dirname+'/time-approval-controls.js','utf8');
const nodes=new Map(),listeners={};
function node(id){if(!nodes.has(id))nodes.set(id,{id:id.slice(1),value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{},open:false,options:[],classList:{toggle(){}},querySelector:selector=>node(id+' '+selector),addEventListener(kind,handler){this[kind]=handler},focus(){},close(){this.open=false},showModal(){this.open=true}});return nodes.get(id)}
for(const id of ['timecard-job','timecard-person','timecard-status'])node('#'+id).value='all';
function card(id,memberId,date,hours,status='submitted'){const inAt=date+'T16:00:00Z';return{id,memberId,projectId:101,date,hours,status,inAt,outAt:new Date(Date.parse(inAt)+hours*3600000).toISOString()}}
const cards=[card(1,1,'2026-10-05',6.5),card(2,1,'2026-10-07',4.5),...[6,6,6,6,6,6,6,4.5].map((hours,i)=>card(i+3,2,'2026-10-06',hours))];
const c={$:node,$$:()=>[],team:[{id:1,name:'Synthetic selected person'},{id:2,name:'Synthetic other person'}],projects:[{id:101,name:'Synthetic job',code:'SYN'}],timeCards:cards,
 currentUser:{id:1,role:'owner'},currentRole:'office',company:{features:{timeCards:true},timezone:'America/Los_Angeles'},
 signedInCompanyId:()=> 'synthetic-tenant',escapeHtml:value=>String(value),fillTimeCardFilters(){},timeCardClock:value=>value,
 timeCardsOn:()=>true,renderEverything(){},showPage(){},document:{body:{classList:{toggle(){}}},addEventListener(kind,handler){(listeners[kind]||=[]).push(handler)}},
 api:async()=>({periods:[],canConfigure:true}),window:null,setTimeout,Intl,Date,JSON,Number,Map};c.window=c;vm.createContext(c);
function sourceFunction(name){const start=app.indexOf('function '+name+'(');assert.ok(start>=0,name);const line=app.slice(start).split('\n')[0];return line.trimEnd().endsWith('}')?line:app.slice(start,app.indexOf('\n}',start)+2)}
for(const name of ['canManageTime','canViewTime','timeCardOffice','timeCardFilters','timeCardApproved','filteredTimeCards','timeCardRowMarkup','updateTimeCardSelection','renderTimeCards'])vm.runInContext(sourceFunction(name),c);
const filterHandler=app.split('\n').find(line=>line.startsWith("['#timecard-job','#timecard-person','#timecard-from','#timecard-to','#timecard-status']"));
assert.ok(filterHandler,'actual filter onchange registration');vm.runInContext(filterHandler,c);
vm.runInContext(controls,c);
async function flush(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))}
async function choose(id='1'){const target={dataset:{timePerson:id},closest:selector=>selector==='[data-time-person]'?target:null};for(const handler of listeners.click||[])await handler({target});await flush()}
async function change(id,value){const field=node('#'+id);field.value=value;await field.onchange?.({target:field});for(const handler of listeners.change||[])await handler({target:field});await flush()}
function expectTotal(hours,count){assert.equal(node('#timecard-filter-total strong').textContent,hours.toFixed(2).replace(/\.00$/,'')+' hours');assert.ok(node('#timecard-filter-total small').textContent.includes('Synthetic selected person'));assert.ok(node('#timecard-filter-total small').textContent.includes(count+' time card'));assert.equal(node('#timecard-filter-total').hidden,false)}
(async()=>{
 c.renderTimeCards();await flush();await choose();expectTotal(11,2);
 assert.match(node('#time-person-name').textContent,/11 hours/);assert.equal((node('#timecard-rows').innerHTML.match(/timecard-record/g)||[]).length,2);
 assert.ok(!node('#timecard-rows').innerHTML.includes('Synthetic other person'),'person rows stay scoped');
 await change('timecard-from','2026-10-07');await change('timecard-to','2026-10-07');
 assert.equal(node('#timecard-filter-total').hidden,true,'changing filters resets person selection');await choose();expectTotal(4.5,1);
 assert.ok(node('#timecard-filter-total small').textContent.includes('2026-10-07 through 2026-10-07'));
 await change('timecard-from','');await change('timecard-to','');c.timeCards[1].status='approved';
 await change('timecard-status','submitted');await choose();expectTotal(6.5,1);
 await change('timecard-status','approved');await choose();expectTotal(4.5,1);
 await change('timecard-status','all');await choose();expectTotal(11,2);
 c.timeCards[0].hours=7;c.renderTimeCards();expectTotal(11.5,2);
 c.timeCards.push({...card(99,1,'2026-10-05',20),deletedAt:'2026-10-08T00:00:00Z'});c.renderTimeCards();expectTotal(11.5,2);
 c.timeCards.push({...card(100,1,'2026-10-05',1),outAt:null,hours:null});c.renderTimeCards();expectTotal(11.5,3);
 node('#time-person-back').onclick();assert.equal(node('#timecard-filter-total').hidden,true,'Back hides the person total');
 c.timeCards=c.timeCards.filter(row=>row.memberId===2);c.renderTimeCards();await choose('2');
 assert.ok(node('#timecard-filter-total small').textContent.includes('Synthetic other person'));assert.equal(node('#timecard-filter-total strong').textContent,'46.50 hours');
 console.log('Time person total passed: 57.50 all-person fixture becomes 11 for the selected person; date/status filters, live refresh, deleted/running cards, Back and switching person stay scoped.');
})().catch(error=>{console.error(error);process.exitCode=1});
