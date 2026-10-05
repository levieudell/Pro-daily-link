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
function buildSalesDemo({ asOf = '2026-10-05', companyId = COMPANY_ID } = {}) {
  if (!payPeriods.validDate(asOf)) throw new Error('asOf must be an ISO calendar date');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new Error('companyId must be a UUID');
  const day = new Date(asOf + 'T12:00:00Z').getUTCDay(), monday = addDays(asOf, -((day + 6) % 7));
  const first = addDays(monday,-28), last = addDays(monday,-3), now = stamp(asOf,'12:00');
  const db = {
    company: {id:companyId,name:'DEMO | Alder Ridge Builders',demo:true,synthetic:true,demoFixture:FIXTURE,demoAsOf:asOf,trade:'General contractor · fictional sales demonstration',email:'office@alder-ridge.example',phone:'(503) 555-0100',address:'DEMO office · fictional address',timezone:'America/Los_Angeles',weekStart:'monday',plan:'pro',planPrice:0,subscriptionStatus:'Demo',billingExempt:true,accountType:'standard',commercialNote:'Synthetic sales demonstration only. No Stripe customer, subscription, payments, payroll processing, or communications.',features:{timeCards:true,templates:false},createdAt:stamp(first,'12:00')},
    users:[],sessions:[],customers:[],projects:[],team:[],crews:[],catalog:[],reports:[],assignments:[],timeCards:[],workdays:[],payPeriods:[],payPeriodExports:[],reportingExports:[],projectNotesTodos:[],photos:[],projectPlans:[],projectTickets:[],subcontractors:[],subcontractorLinks:[],changes:[],timeOffRequests:[],auditLog:[]
  };
  const specs = [
    {id:1,customer:'DEMO Cedar Grove Community',contact:'DEMO Dana Brooks',name:'DEMO Cedar Grove Clinic',code:'D-CGC',crew:'DEMO Concrete',members:[1,2,3],color:'#dcebe4',line:'Slab on grade',planned:18000,budget:720,cost:216000,quantities:[600,640,660,680,720],status:'On track',next:'Continue the west wing slab sequence; verify curing protection.'},
    {id:2,customer:'DEMO Juniper Housing',contact:'DEMO Casey Wells',name:'DEMO Juniper Townhomes',code:'D-JTH',crew:'DEMO Framing',members:[4,5,6],color:'#e6e1f2',line:'Wood wall framing',planned:20000,budget:720,cost:280000,quantities:[540,580,600,620,660],status:'At risk',next:'Stage the prefabricated headers before the next shift to recover framing pace.'},
    {id:3,customer:'DEMO Harbor Retail Group',contact:'DEMO Riley Shaw',name:'DEMO Harbor Market Fit-out',code:'D-HMF',crew:'DEMO Interiors',members:[7,8],color:'#e9e3d6',line:'Drywall partitions',planned:10000,budget:400,cost:125000,quantities:[375,400,425,450,475],status:'On track',next:'Complete the back-of-house partitions before the inspection walk.'}
  ];
  const people = ['DEMO Avery Stone','DEMO Jordan Reed','DEMO Taylor Quinn','DEMO Cameron Hayes','DEMO Rowan Clark','DEMO Parker Lane','DEMO Emery Brooks','DEMO Finley Hart'];
  for (const spec of specs) {
    db.customers.push({id:spec.id,name:spec.customer,contact:spec.contact,email:`customer-${spec.id}@alder-ridge.example`,phone:`(503) 555-010${spec.id}`});
    db.crews.push({id:spec.id,name:spec.crew,createdAt:stamp(first,'12:00')});
    db.catalog.push({id:spec.id,name:spec.line,unit:'SF',hoursPerUnit:spec.budget/spec.planned});
    db.projects.push({id:spec.id,customerId:spec.id,name:spec.name,customer:spec.customer,code:spec.code,color:spec.color,site:`DEMO site ${spec.id} · fictional location`,crew:spec.members.length,progress:0,production:0,status:spec.status,budget:`$${spec.cost/1000}K`,contractType:'estimated',startDate:first,endDate:addDays(monday,28),supervisor:people[spec.members[0]-1],siteContact:spec.contact,estimateItems:[{id:1,catalogItemId:spec.id,name:spec.line,plannedQuantity:spec.planned,unit:'SF',budgetHours:spec.budget,cost:spec.cost}],synthetic:true});
    for (const memberId of spec.members) db.team.push({id:memberId,name:people[memberId-1],role:memberId===spec.members[0]?'Foreman':'Craftsperson',initials:people[memberId-1].replace('DEMO ','').split(' ').map(n=>n[0]).join(''),crew:spec.crew,hours:40,site:spec.name,phone:`(503) 555-01${String(memberId+10).padStart(2,'0')}`,email:`crew-${memberId}@alder-ridge.example`,synthetic:true});
  }
  for (let week = 0; week < 4; week++) for (let weekday = 0; weekday < 5; weekday++) {
    const date=addDays(first,week*7+weekday);
    for (const spec of specs) {
      const finalPending=week===3&&weekday===4&&spec.id!==1, reportId=db.reports.length+1, workdayId=db.workdays.length+1;
      const foreman=people[spec.members[0]-1], hours=spec.members.length*8, quantity=spec.quantities[weekday];
      const delay=spec.id===2&&weekday===1?'DEMO observation: header delivery arrived 45 minutes late; crew shifted to layout.':'';
      const summary=`DEMO synthetic history: installed ${quantity.toLocaleString('en-US')} SF of ${spec.line.toLowerCase()} with ${hours} crew hours.${delay?' Header staging remains the recovery priority.':''}`;
      db.assignments.push({id:db.assignments.length+1,projectId:spec.id,memberIds:[...spec.members],crew:spec.crew,date,start:'07:00',end:'15:30',activity:`DEMO week ${week+1}: ${spec.line}`,acknowledgements:Object.fromEntries(spec.members.map(id=>[id,{at:stamp(date,'13:45'),by:people[id-1]}]))});
      db.workdays.push({id:workdayId,projectId:spec.id,memberIds:[...spec.members],status:'complete',startedAt:stamp(date,'14:00'),endedAt:stamp(date,'22:30'),startNote:'DEMO synthetic shift.',endNotes:summary,reportId});
      for (const memberId of spec.members) {
        const status=finalPending?(memberId===8?'draft':'submitted'):'approved';
        db.timeCards.push({id:db.timeCards.length+1,projectId:spec.id,memberId,date,inAt:stamp(date,'14:00'),outAt:stamp(date,'22:30'),hours:8,breaks:[{type:'unpaid_meal',startedAt:stamp(date,'19:00'),endedAt:stamp(date,'19:30')}],status,workdayId,reportId,submittedAt:status==='draft'?null:stamp(date,'22:35'),submittedBy:status==='draft'?null:people[memberId-1],approvedBy:status==='approved'?ACTOR.name:null,approvedAt:status==='approved'?stamp(date,'23:00'):null,history:[{action:'Opened',by:foreman,at:stamp(date,'14:00')},{action:'Clocked out',by:foreman,at:stamp(date,'22:30')},...(status!=='draft'?[{action:'Submitted',by:people[memberId-1],at:stamp(date,'22:35')}]:[]),...(status==='approved'?[{action:'Approved',by:ACTOR.name,at:stamp(date,'23:00')}]:[])],synthetic:true});
      }
      db.reports.push({id:reportId,workdayId,project:spec.id-1,date:dateLabel(date),dateIso:date,foreman,status:finalPending?'Needs review':'Approved',notes:summary,summary,labor:`${spec.members.length} people · ${hours} hours`,quantity:`${quantity} SF`,issue:delay||'DEMO: no issue recorded',next:spec.next,weather:weekday===1?'Cloudy':'Clear',temperature:'64',productionEntries:[{estimateItemId:1,catalogItemId:spec.id,description:spec.line,quantity,unit:'SF',laborHours:hours}],laborEntries:spec.members.map(memberId=>({memberId,hours:8,crew:spec.crew})),materials:spec.id===1?'DEMO concrete mix and curing compound':spec.id===2?'DEMO framing lumber and connectors':'DEMO gypsum board and track',equipment:spec.id===1?'DEMO pump and power screed':spec.id===2?'DEMO telehandler':'DEMO rolling scaffold',delays:delay,safety:'DEMO synthetic observation: access routes checked; no incident recorded.',signature:foreman,flags:[],createdAt:stamp(date,'22:40'),submittedAt:stamp(date,'22:40'),history:[{action:'Submitted',by:foreman,at:stamp(date,'22:40')},...(!finalPending?[{action:'Approved',by:ACTOR.name,actorId:ACTOR.id,at:stamp(date,'23:10')}]:[])],synthetic:true});
    }
  }
  for (let weekday=0;weekday<5;weekday++) for(const spec of specs) db.assignments.push({id:db.assignments.length+1,projectId:spec.id,memberIds:[...spec.members],crew:spec.crew,date:addDays(monday,weekday),start:'07:00',end:'15:30',activity:`DEMO upcoming: ${spec.next}`});
  for(const project of db.projects) {const approved=db.reports.filter(r=>r.project===project.id-1&&r.status==='Approved'),q=approved.reduce((n,r)=>n+r.productionEntries[0].quantity,0);project.production=Math.round(q/project.estimateItems[0].plannedQuantity*1000)/10;project.progress=Math.min(100,Math.round(project.production));}
  for(let week=0;week<4;week++) {
    const from=addDays(first,week*7),to=addDays(from,6),period={id:uuid('period-'+week),label:`DEMO week ${week+1} · ${dateLabel(from)}–${dateLabel(to)}`,from,to,timeZone:db.company.timezone,status:'open',createdAt:stamp(from,'12:00'),updatedAt:stamp(from,'12:00')};
    db.payPeriods.push(period);
    if(week<3){const exp=payPeriods.capture(db,period,{},ACTOR);exp.id=uuid('pay-export-'+week);exp.createdAt=stamp(to,'23:30');period.closedAt=exp.createdAt;db.auditLog.at(-1).id=uuid('pay-audit-'+week);db.auditLog.at(-1).at=exp.createdAt;db.auditLog.at(-1).exportId=exp.id;}
  }
  const capturedThrough=addDays(first,20),historical=structuredClone(db);
  for(const project of historical.projects){const quantity=historical.reports.filter(r=>r.project===project.id-1&&r.status==='Approved'&&r.dateIso<=capturedThrough).reduce((sum,r)=>sum+r.productionEntries[0].quantity,0);project.production=Math.round(quantity/project.estimateItems[0].plannedQuantity*1000)/10;project.progress=Math.min(100,Math.round(project.production));}
  for (const project of historical.projects) {const record=createReportingExport(historical,{projectId:project.id,from:first,to:capturedThrough},ACTOR,stamp(capturedThrough,'23:40'));record.id=uuid('production-export-'+project.id);record.seriesId=record.id;db.reportingExports.push(record);}
  for (const [i,entry] of [{projectId:2,kind:'note',text:'DEMO: Framing is using labor faster than installed quantity. Check header staging before expanding the crew.',completed:false},{projectId:2,kind:'todo',text:'DEMO: Stage prefabricated headers at the east laydown area before the next shift.',completed:false},{projectId:1,kind:'todo',text:'DEMO: Confirm the slab inspection sequence with the fictional site contact.',completed:true}].entries()) {
    const createdValue={text:entry.text,completed:false,revision:1},value={text:entry.text,completed:entry.completed,revision:entry.completed?2:1};
    db.projectNotesTodos.push({id:uuid('note-'+i),companyId,requestId:'demo-note-'+i,projectId:entry.projectId,kind:entry.kind,...value,createdBy:ACTOR.name,createdByUserId:ACTOR.id,createdAt:stamp(last,'23:35'),updatedBy:ACTOR.name,updatedByUserId:ACTOR.id,updatedAt:stamp(last,entry.completed?'23:45':'23:35'),history:[{action:'Created',by:ACTOR.name,userId:ACTOR.id,at:stamp(last,'23:35'),before:null,after:createdValue},...(entry.completed?[{action:'Completed',by:ACTOR.name,userId:ACTOR.id,at:stamp(last,'23:45'),before:createdValue,after:value}]:[])],synthetic:true});
  }
  db.reports.sort((a,b)=>b.dateIso.localeCompare(a.dateIso)||b.id-a.id);
  db.auditLog.push({id:uuid('fixture-created'),type:'synthetic_demo_fixture',actor:'DEMO fixture generator',at:now,detail:`${FIXTURE}: wholly fictional records, historical ${first} through ${last}; generated as of ${asOf}. No actual work, approval, payment or message occurred.`});
  return db;
}
function summarizeSalesDemo(db) {
  const projects=db.projects.map((p,index)=>{const reports=db.reports.filter(r=>r.project===index&&r.status==='Approved'),quantity=reports.reduce((n,r)=>n+r.productionEntries.reduce((s,e)=>s+e.quantity,0),0),hours=reports.reduce((n,r)=>n+r.laborEntries.reduce((s,e)=>s+e.hours,0),0),item=p.estimateItems[0],earnedHours=quantity/item.plannedQuantity*item.budgetHours;return {id:p.id,name:p.name,approvedReports:reports.length,quantity,plannedQuantity:item.plannedQuantity,hours,budgetHours:item.budgetHours,earnedHours:Math.round(earnedHours*100)/100,efficiency:Math.round(earnedHours/hours*10000)/100};});
  return {fixture:FIXTURE,asOf:db.company.demoAsOf,companyId:db.company.id,companyName:db.company.name,counts:Object.fromEntries(['customers','projects','team','crews','reports','assignments','timeCards','workdays','payPeriods','payPeriodExports','reportingExports','projectNotesTodos'].map(k=>[k,db[k].length])),approvedReports:db.reports.filter(r=>r.status==='Approved').length,reviewReports:db.reports.filter(r=>r.status==='Needs review').length,time: Object.fromEntries(['approved','submitted','draft'].map(status=>[status,{cards:db.timeCards.filter(c=>c.status===status).length,hours:db.timeCards.filter(c=>c.status===status).reduce((n,c)=>n+c.hours,0)}])),projects,periods:db.payPeriods.map(p=>({id:p.id,status:p.status,...payPeriods.summary(db,p)}))};
}
module.exports={FIXTURE,COMPANY_ID,ACTOR,buildSalesDemo,summarizeSalesDemo};
