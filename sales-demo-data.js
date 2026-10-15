'use strict';
// Pure, credential-free synthetic data. Never reads or writes any tenant or service.
const crypto = require('node:crypto');
const payPeriods = require('./pay-periods');
const { createReportingExport } = require('./reporting-exports');
const FIXTURE = 'pdl-sales-demo-v1';
const COMPANY_ID = 'ad1de000-d300-4000-8000-000000000001';
const ACTOR = { id: 'demo-office', name: 'DEMO Morgan Ellis', role: 'owner' };
const addDays = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const uuid = label => { const h = crypto.createHash('sha256').update(FIXTURE + ':' + label).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
function stamp(date, time = '23:00') {
  // Fixture times below use a PDT wall-clock baseline. Shift UTC by one hour
  // in standard time so schedules remain 07:00–15:30 in the company timezone.
  const zone = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'shortOffset'}).formatToParts(new Date(date+'T12:00:00Z')).find(p=>p.type==='timeZoneName').value;
  const offset = Number(zone.match(/GMT([+-]\d+)/)?.[1] ?? 0);
  return new Date(Date.parse(`${date}T${time}:00.000Z`) + (-offset-7)*3600000).toISOString();
}
const dateLabel = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {timeZone:'UTC',month:'short',day:'numeric'});
// One shared 1×1 placeholder pixel (safety orange) so photo surfaces render in
// demos without bundling real site imagery. Every caption is labeled DEMO.
const DEMO_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4EyUHAAM6AUVCnvSSAAAAAElFTkSuQmCC';
function buildSalesDemo({ asOf = '2026-10-05', companyId = COMPANY_ID } = {}) {
  if (!payPeriods.validDate(asOf)) throw new Error('asOf must be an ISO calendar date');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new Error('companyId must be a UUID');
  const day = new Date(asOf + 'T12:00:00Z').getUTCDay(), monday = addDays(asOf, -((day + 6) % 7));
  const first = addDays(monday,-14), last = addDays(monday,-3), now = stamp(asOf,'12:00');
  const db = {
    company: {id:companyId,name:'DEMO | Alder Ridge Excavation & Concrete',demo:true,synthetic:true,demoFixture:FIXTURE,demoAsOf:asOf,trade:'Excavation, utilities & concrete · fictional sales demonstration',email:'office@alder-ridge.example',phone:'(503) 555-0100',address:'DEMO office · fictional address',timezone:'America/Los_Angeles',weekStart:'monday',plan:'pro',planPrice:0,subscriptionStatus:'Demo',billingExempt:true,accountType:'standard',commercialNote:'Synthetic sales demonstration only. No Stripe customer, subscription, payments, payroll processing, or communications.',features:{timeCards:true,templates:false},createdAt:stamp(first,'12:00')},
    users:[],sessions:[],customers:[],projects:[],team:[],crews:[],catalog:[],reports:[],assignments:[],timeCards:[],workdays:[],payPeriods:[],payPeriodExports:[],reportingExports:[],projectNotesTodos:[],photos:[],projectPlans:[],projectTickets:[],subcontractors:[],subcontractorLinks:[],changes:[],timeOffRequests:[],projectMessages:[],auditLog:[]
  };
  // Six catalog items across the trades a sitework buyer recognizes.
  const catalog = [
    {id:1,name:'Mass excavation',unit:'CY',category:'Earthwork',targetHoursPerUnit:0.08},
    {id:2,name:'Trench excavation & backfill',unit:'LF',category:'Utilities',targetHoursPerUnit:0.20},
    {id:3,name:'8" DI pipe install',unit:'LF',category:'Utilities',targetHoursPerUnit:0.10},
    {id:4,name:'Structural fill/compaction',unit:'CY',category:'Earthwork',targetHoursPerUnit:0.08},
    {id:5,name:'Footings',unit:'CY',category:'Concrete',targetHoursPerUnit:1.0},
    {id:6,name:'Slab on grade',unit:'SF',category:'Concrete',targetHoursPerUnit:0.04}
  ];
  db.catalog = catalog.map(item => ({...item, createdAt: stamp(first,'12:00'), synthetic:true}));
  const specs = [
    {id:1,customer:'DEMO Riverbend Development',contact:'DEMO Dana Whitfield',name:'DEMO Riverbend Subdivision Phase 2',code:'D-RB2',color:'#dcebe4',crew:'DEMO Dirt Crew',members:[1,2,3],site:'17875 SW Farmington Rd, Beaverton, OR 97005',items:[{catalogId:1,name:'Mass excavation',unit:'CY',plannedQuantity:2000,budgetHours:160,cost:96000},{catalogId:4,name:'Structural fill/compaction',unit:'CY',plannedQuantity:1200,budgetHours:96,cost:28800}],status:'On track',scope:'mass grading, storm and sanitary',next:'Finish structural fill in the northeast lot; verify compaction tests before the storm pipe tie-in.'},
    {id:2,customer:'DEMO Cascade Water District',contact:'DEMO Pat Cervantes',name:'DEMO Hwy 99 Waterline Replacement',code:'D-HW9',color:'#e6e1f2',crew:'DEMO Pipe Crew',members:[4,5,6],site:'12950 SW Pacific Hwy, Tigard, OR 97223',items:[{catalogId:2,name:'Trench excavation & backfill',unit:'LF',plannedQuantity:1500,budgetHours:300,cost:90000},{catalogId:3,name:'8" DI pipe install',unit:'LF',plannedQuantity:1400,budgetHours:140,cost:42000}],status:'At risk',scope:'8" DI waterline, trench and backfill',next:'Bring the rock trencher to station 12+40; sandstone is running triple the bid rate.'},
    {id:3,customer:'DEMO Cedar Grove Holdings',contact:'DEMO Riley Osei',name:'DEMO Cedar Grove Commercial Pad',code:'D-CGP',color:'#e9e3d6',crew:'DEMO Concrete Crew',members:[7,8,9],site:'2048 NE 25th Ave, Hillsboro, OR 97124',items:[{catalogId:5,name:'Footings',unit:'CY',plannedQuantity:240,budgetHours:240,cost:72000},{catalogId:6,name:'Slab on grade',unit:'SF',plannedQuantity:12000,budgetHours:480,cost:144000}],status:'On track',scope:'building pad, footings, slab on grade',next:'Pour the east half of the slab; protect the cure with the cold-weather blankets on site.'}
  ];
  const people = ['DEMO Marcus Hale','DEMO Cody Briggs','DEMO Eli Navarro','DEMO Ray Dalton','DEMO Sam Okafor','DEMO Luis Herrera','DEMO Tony Marsh','DEMO Omar Reyes','DEMO Dev Khatri'];
  const equipment = ['DEMO CAT 336 excavator and D6 dozer','DEMO PC290 excavator, 8" pipe laser and compactor','DEMO laser screed, power trowels and telehandler'];
  const materials = ['DEMO structural fill and filter fabric','DEMO 8" DI pipe, bedding stone and wrap','DEMO rebar, embeds and 4000-psi concrete mix'];
  // What the crew works on each of the ten history weekdays (two per project).
  // P1: six days of mass excavation then four of structural fill (on track).
  // P2: five days of trenching then five of pipe (sandstone makes it fall behind).
  // P3: four days of footings then six of slab (ahead, with extra work in the mix).
  const program = {
    1: [[1,300],[1,300],[1,300],[1,300],[1,300],[1,300],[2,300],[2,300],[2,300],[2,300]],
    2: [[1,60],[1,60],[1,60],[1,60],[1,60],[2,120],[2,120],[2,120],[2,120],[2,120]],
    3: [[1,24],[1,24],[1,24],[1,24],[2,600],[2,600],[2,600],[2,600],[2,600],[2,600]]
  };
  const weather = ['Clear','Cloudy','Clear','Light rain','Clear'];
  const reportIds = {};
  for (const spec of specs) {
    db.customers.push({id:spec.id,name:spec.customer,contact:spec.contact,email:`customer-${spec.id}@alder-ridge.example`,phone:`(503) 555-010${spec.id}`});
    db.crews.push({id:spec.id,name:spec.crew,createdAt:stamp(first,'12:00')});
    db.projects.push({id:spec.id,customerId:spec.id,name:spec.name,customer:spec.customer,code:spec.code,color:spec.color,site:spec.site,crew:spec.members.length,progress:0,production:0,status:spec.status,budget:`$${Math.round(spec.items.reduce((n,i)=>n+i.cost,0)/1000)}K`,contractType:'estimated',startDate:first,endDate:addDays(monday,28),supervisor:people[spec.members[0]-1],siteContact:spec.contact,estimateItems:spec.items.map((item,index)=>({id:index+1,catalogItemId:item.catalogId,name:item.name,plannedQuantity:item.plannedQuantity,unit:item.unit,budgetHours:item.budgetHours,cost:item.cost})),synthetic:true});
    for (const memberId of spec.members) db.team.push({id:memberId,name:people[memberId-1],role:memberId===spec.members[0]?'Foreman':'Operator/laborer',initials:people[memberId-1].replace('DEMO ','').split(' ').map(n=>n[0]).join(''),crew:spec.crew,hours:40,site:spec.name,phone:`(503) 555-01${String(memberId+10).padStart(2,'0')}`,email:`crew-${memberId}@alder-ridge.example`,synthetic:true});
  }
  for (let week = 0; week < 2; week++) for (let weekday = 0; weekday < 5; weekday++) {
    const dayIndex = week*5+weekday, date=addDays(first,week*7+weekday);
    for (const spec of specs) {
      const [itemNo, quantity] = program[spec.id][dayIndex];
      const item = spec.items[itemNo-1];
      const finalPending=dayIndex===9&&spec.id!==1, reportId=db.reports.length+1, workdayId=db.workdays.length+1;
      reportIds[`${spec.id}-${dayIndex}`]=reportId;
      const foreman=people[spec.members[0]-1], hours=spec.members.length*8;
      const lateStart=spec.id===3&&dayIndex===2;
      const sandstone=spec.id===2?'DEMO observation: sandstone lens at the face is slowing '+ (itemNo===1?'trench':'pipe bedding') + ' production; the rock trencher is the recovery plan.':'';
      const flat=lateStart?'DEMO note: pump trailer had a flat on the haul route — crew started 45 minutes late.':'';
      const summary=`DEMO synthetic history: placed ${quantity.toLocaleString('en-US')} ${item.unit} of ${item.name.toLowerCase()} with ${hours} crew hours.${sandstone?' '+sandstone:''}${flat?' '+flat:''}`;
      db.assignments.push({id:db.assignments.length+1,projectId:spec.id,memberIds:[...spec.members],crew:spec.crew,date,start:'07:00',end:'15:30',activity:`DEMO week ${week+1}: ${item.name}`,acknowledgements:Object.fromEntries(spec.members.map(id=>[id,{at:stamp(date,'13:45'),by:people[id-1]}]))});
      db.workdays.push({id:workdayId,projectId:spec.id,memberIds:[...spec.members],status:'complete',startedAt:stamp(date,lateStart?'14:45':'14:00'),endedAt:stamp(date,lateStart?'23:15':'22:30'),startNote:'DEMO synthetic shift.',endNotes:summary,reportId});
      for (const memberId of spec.members) {
        const status=finalPending?(memberId===9?'draft':'submitted'):'approved';
        db.timeCards.push({id:db.timeCards.length+1,projectId:spec.id,memberId,date,inAt:stamp(date,lateStart?'14:45':'14:00'),outAt:stamp(date,lateStart?'23:15':'22:30'),hours:8,breaks:[{type:'unpaid_meal',startedAt:stamp(date,lateStart?'19:45':'19:00'),endedAt:stamp(date,lateStart?'20:15':'19:30')}],status,workdayId,reportId,submittedAt:status==='draft'?null:stamp(date,'22:35'),submittedBy:status==='draft'?null:people[memberId-1],approvedBy:status==='approved'?ACTOR.name:null,approvedAt:status==='approved'?stamp(date,'23:00'):null,history:[{action:'Opened',by:foreman,at:stamp(date,lateStart?'14:45':'14:00')},{action:'Clocked out',by:foreman,at:stamp(date,lateStart?'23:15':'22:30')},...(status!=='draft'?[{action:'Submitted',by:people[memberId-1],at:stamp(date,'22:35')}]:[]),...(status==='approved'?[{action:'Approved',by:ACTOR.name,at:stamp(date,'23:00')}]:[])],synthetic:true});
      }
      db.reports.push({id:reportId,workdayId,project:spec.id-1,date:dateLabel(date),dateIso:date,foreman,status:finalPending?'Needs review':'Approved',notes:summary,summary,labor:`${spec.members.length} people · ${hours} hours`,quantity:`${quantity} ${item.unit}`,issue:sandstone||flat||'DEMO: no issue recorded',next:spec.next,weather:weather[weekday],temperature:String(58+weekday*2),productionEntries:[{estimateItemId:itemNo,catalogItemId:item.catalogId,description:item.name,quantity,unit:item.unit,laborHours:hours}],laborEntries:spec.members.map(memberId=>({memberId,hours:8,crew:spec.crew})),materials:materials[spec.id-1],equipment:equipment[spec.id-1],delays:sandstone||flat,safety:'DEMO synthetic observation: trench access and spoils piles checked; no incident recorded.',signature:foreman,flags:[],createdAt:stamp(date,'22:40'),submittedAt:stamp(date,'22:40'),history:[{action:'Submitted',by:foreman,at:stamp(date,'22:40')},...(!finalPending?[{action:'Approved',by:ACTOR.name,actorId:ACTOR.id,at:stamp(date,'23:10')}]:[])],synthetic:true});
    }
  }
  // Photo placeholders: two per project on the third and eighth workdays.
  for (const spec of specs) for (const dayIndex of [2,7]) {
    const date=addDays(first,dayIndex), [itemNo] = program[spec.id][dayIndex], item=spec.items[itemNo-1];
    db.photos.push({id:uuid(`photo-${spec.id}-${dayIndex}`),project:spec.id-1,projectId:spec.id,reportId:reportIds[`${spec.id}-${dayIndex}`],source:'field',caption:`DEMO placeholder photo — ${item.name}`,tags:['demo'],capturedAt:stamp(date,'18:00'),uploader:people[spec.members[0]-1],createdAt:stamp(date,'22:45'),phase:'end',url:DEMO_PHOTO,synthetic:true});
  }
  // Schedule beyond the history: this week and next, plus one deliberately
  // orphaned day (a scheduled crew with no daily) so the action center has a
  // realistic "missing daily" flag that is not the demo's own seed week.
  const weekdayIndex=(day+6)%7;
  for (let offset=0;offset<=4-weekdayIndex;offset++) for (const spec of specs) db.assignments.push({id:db.assignments.length+1,projectId:spec.id,memberIds:[...spec.members],crew:spec.crew,date:addDays(asOf,offset),start:'07:00',end:'15:30',activity:`DEMO upcoming: ${spec.next}`});
  db.assignments.push({id:db.assignments.length+1,projectId:1,memberIds:[...specs[0].members],crew:specs[0].crew,date:addDays(first,-4),start:'07:00',end:'15:30',activity:'DEMO: Mass excavation — crew was scheduled, no daily was filed'});
  // Change orders at three stages: field-flagged potential, submitted T&M, approved additive.
  db.changes.push(
    {id:uuid('co-101'),projectId:1,number:'CO-101',title:'Unmarked utility strike — T&M',reason:'DEMO: the private locate missed a stub service lateral in the north cut',detail:'DEMO: 4 crew hours, hand excavation and a replacement sweep; billed time and materials.',status:'Potential',amount:4800,createdBy:people[0],createdAt:stamp(addDays(first,3),'20:00'),reportId:reportIds['1-3'],lines:[],fieldFlag:true,synthetic:true},
    {id:uuid('co-102'),projectId:2,number:'CO-102',title:'Extra rock excavation',reason:'DEMO: sandstone lens beyond the bid trench section',detail:'DEMO: 850 CY of rock excavation at the bid T&M rate; awaiting district decision.',status:'Submitted',amount:12750,createdBy:people[3],createdAt:stamp(addDays(first,8),'20:00'),submittedAt:stamp(addDays(first,8),'20:05'),reportId:reportIds['2-8'],lines:[],synthetic:true},
    {id:uuid('co-103'),projectId:3,number:'CO-103',title:'Owner-added sidewalk',reason:'DEMO: owner added a 120 LF sidewalk at the north entrance',detail:'DEMO: sawcut, grade, form and finish approved as an additive.',status:'Approved',amount:3200,createdBy:people[6],createdAt:stamp(addDays(first,7),'20:00'),submittedAt:stamp(addDays(first,7),'20:05'),decidedAt:stamp(addDays(first,9),'21:00'),decidedBy:ACTOR.name,decisionNote:'DEMO: approved as additive',reportId:reportIds['3-7'],lines:[],synthetic:true}
  );
  // Office → field messages so the Messages screen is alive in demos.
  db.projectMessages.push(
    {id:uuid('msg-1'),projectId:2,memberId:4,sender:'office',senderName:ACTOR.name,senderId:ACTOR.id,text:'DEMO: storm inspector walks the trench Thursday at 10:00 — have bedding and compaction photos ready.',createdAt:stamp(addDays(first,4),'18:00'),readBy:['field']},
    {id:uuid('msg-2'),projectId:1,memberId:1,sender:'office',senderName:ACTOR.name,senderId:ACTOR.id,text:'DEMO: utility locate clears the north lot Monday morning. Re-call 811 before the trench passes station 14+00.',createdAt:stamp(addDays(first,6),'17:30'),readBy:[]}
  );
  for(const project of db.projects) {const approved=db.reports.filter(r=>r.project===project.id-1&&r.status==='Approved'),q=approved.reduce((n,r)=>n+r.productionEntries[0].quantity,0);project.production=Math.round(q/project.estimateItems[0].plannedQuantity*1000)/10;project.progress=Math.min(100,Math.round(project.production));}
  for (let week=0;week<2;week++) {
    const from=addDays(first,week*7),to=addDays(from,6),period={id:uuid('period-'+week),label:`DEMO week ${week+1} · ${dateLabel(from)}–${dateLabel(to)}`,from,to,timeZone:db.company.timezone,status:'open',createdAt:stamp(from,'12:00'),updatedAt:stamp(from,'12:00')};
    db.payPeriods.push(period);
    if(week<1){const exp=payPeriods.capture(db,period,{},ACTOR);exp.id=uuid('pay-export-'+week);exp.createdAt=stamp(to,'23:30');period.closedAt=exp.createdAt;db.auditLog.at(-1).id=uuid('pay-audit-'+week);db.auditLog.at(-1).at=exp.createdAt;db.auditLog.at(-1).exportId=exp.id;}
  }
  // One fixed export for the closed week, project 1, captured before week 2 ran.
  const capturedThrough=addDays(first,6),historical=structuredClone(db);
  for(const project of historical.projects){const quantity=historical.reports.filter(r=>r.project===project.id-1&&r.status==='Approved'&&r.dateIso<=capturedThrough).reduce((sum,r)=>sum+r.productionEntries[0].quantity,0);project.production=Math.round(quantity/project.estimateItems[0].plannedQuantity*1000)/10;project.progress=Math.min(100,Math.round(project.production));}
  {const record=createReportingExport(historical,{projectId:1,from:first,to:capturedThrough},ACTOR,stamp(capturedThrough,'23:40'));record.id=uuid('production-export-1');record.seriesId=record.id;db.reportingExports.push(record);}
  for (const [i,entry] of [{projectId:2,kind:'note',text:'DEMO: Sandstone is running triple the bid trench rate. Do not add labor — get the rock trencher on site first.',completed:false},{projectId:2,kind:'todo',text:'DEMO: Rent the rock trencher and confirm the Cascade Water District inspector for Thursday.',completed:false}].entries()) {
    const createdValue={text:entry.text,completed:false,revision:1},value={text:entry.text,completed:entry.completed,revision:entry.completed?2:1};
    db.projectNotesTodos.push({id:uuid('note-'+i),companyId,requestId:'demo-note-'+i,projectId:entry.projectId,kind:entry.kind,...value,createdBy:ACTOR.name,createdByUserId:ACTOR.id,createdAt:stamp(last,'23:35'),updatedBy:ACTOR.name,updatedByUserId:ACTOR.id,updatedAt:stamp(last,entry.completed?'23:45':'23:35'),history:[{action:'Created',by:ACTOR.name,userId:ACTOR.id,at:stamp(last,'23:35'),before:null,after:createdValue},...(entry.completed?[{action:'Completed',by:ACTOR.name,userId:ACTOR.id,at:stamp(last,'23:45'),before:createdValue,after:value}]:[])],synthetic:true});
  }
  db.reports.sort((a,b)=>b.dateIso.localeCompare(a.dateIso)||b.id-a.id);
  db.auditLog.push({id:uuid('fixture-created'),type:'synthetic_demo_fixture',actor:'DEMO fixture generator',at:now,detail:`${FIXTURE}: wholly fictional records, historical ${first} through ${last}; generated as of ${asOf}. No actual work, approval, payment or message occurred.`});
  return db;
}
function summarizeSalesDemo(db) {
  const projects=db.projects.map((p,index)=>{const reports=db.reports.filter(r=>r.project===index&&r.status==='Approved'),quantity=reports.reduce((n,r)=>n+r.productionEntries.reduce((s,e)=>s+e.quantity,0),0),hours=reports.reduce((n,r)=>n+r.laborEntries.reduce((s,e)=>s+e.hours,0),0),earnedHours=p.estimateItems.reduce((sum,item)=>{const q=reports.reduce((n,r)=>n+r.productionEntries.filter(e=>e.estimateItemId===item.id).reduce((s,e)=>s+e.quantity,0),0);return sum+q/item.plannedQuantity*item.budgetHours},0);return {id:p.id,name:p.name,approvedReports:reports.length,quantity,plannedQuantity:p.estimateItems[0].plannedQuantity,hours,budgetHours:p.estimateItems[0].budgetHours,earnedHours:Math.round(earnedHours*100)/100,efficiency:Math.round(earnedHours/hours*10000)/100};});
  return {fixture:FIXTURE,asOf:db.company.demoAsOf,companyId:db.company.id,companyName:db.company.name,counts:Object.fromEntries(['customers','projects','team','crews','reports','assignments','timeCards','workdays','payPeriods','payPeriodExports','reportingExports','projectNotesTodos','photos','changes','projectMessages'].map(k=>[k,db[k].length])),approvedReports:db.reports.filter(r=>r.status==='Approved').length,reviewReports:db.reports.filter(r=>r.status==='Needs review').length,time: Object.fromEntries(['approved','submitted','draft'].map(status=>[status,{cards:db.timeCards.filter(c=>c.status===status).length,hours:db.timeCards.filter(c=>c.status===status).reduce((n,c)=>n+c.hours,0)}])),projects,periods:db.payPeriods.map(p=>({id:p.id,status:p.status,...payPeriods.summary(db,p)}))};
}
module.exports={FIXTURE,COMPANY_ID,ACTOR,buildSalesDemo,summarizeSalesDemo};
