'use strict';
const crypto=require('node:crypto'),csvCell=require('./csv-cell');
function fail(message,statusCode=400){throw Object.assign(new Error(message),{statusCode})}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value}
function zone(value){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return value}catch{fail('Configure a valid company timezone')}}
function dateAt(instant,timeZone){if(typeof instant!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(instant)||!Number.isFinite(Date.parse(instant)))return null;const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant)),get=type=>parts.find(p=>p.type===type).value;return `${get('year')}-${get('month')}-${get('day')}`}
function completeCard(card){return Boolean(dateAt(card.inAt,'UTC')&&dateAt(card.outAt,'UTC')&&Number.isFinite(Date.parse(card.inAt))&&Date.parse(card.outAt)>Date.parse(card.inAt)&&card.hours!=null&&typeof card.hours!=='boolean'&&String(card.hours).trim()!==''&&Number.isFinite(Number(card.hours))&&Number(card.hours)>=0)}
function publicPeriod(period){const {id,label,from,to,timeZone}=period;return{id,label,from,to,timeZone}}
function savePeriod(db,input,actor,id=null){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['label','from','to','reason'].includes(k)))fail('Set a label and explicit start/end dates');
  if(!validDate(input.from)||!validDate(input.to)||input.from>input.to)fail('Choose a valid inclusive start/end date range');
  const label=String(input.label||`${input.from} through ${input.to}`).trim();if(!label||label.length>120)fail('Use a period label of 1-120 characters');
  const previous=id?(db.payPeriods||[]).find(p=>p.id===id):null;if(id&&!previous)fail('Pay period not found',404);
  if(previous&&(db.payPeriodExports||[]).some(e=>e.periodId===id))fail('Captured period dates are fixed; create a separate period instead',409);
  if((db.payPeriods||[]).some(p=>p.id!==id&&p.from<=input.to&&p.to>=input.from))fail('Company pay periods cannot overlap, including their boundary dates',409);
  if(previous&&!String(input.reason||'').trim())fail('Explain the period setting correction');
  const now=new Date().toISOString(),period={id:previous?.id||crypto.randomUUID(),label,from:input.from,to:input.to,timeZone:previous?.timeZone||zone(db.company.timezone||'America/Los_Angeles'),status:'open',createdAt:previous?.createdAt||now,updatedAt:now};
  const before=previous?structuredClone(publicPeriod(previous)):null;
  db.payPeriods ||= [];if(previous)Object.assign(previous,period);else db.payPeriods.push(period);
  db.auditLog ||= [];db.auditLog.push({id:crypto.randomUUID(),type:previous?'pay_period_updated':'pay_period_created',periodId:period.id,actor:actor.name,at:now,before,after:publicPeriod(period),detail:previous?String(input.reason).trim():'Company-specific inclusive dates configured'});return period;
}
function summary(db,period,{cards=db.timeCards||[],assignments=db.assignments||[],isApproved=c=>String(c.status||'').toLowerCase()==='approved'}={}){
  const review={draft:0,submitted:0,running:0,invalid:0,undated:0,missingScheduledEntries:0},records=[],present=new Set(),people=new Map();
  for(const card of cards){
    if(card.deletedAt)continue;const date=dateAt(card.inAt,period.timeZone);if(!date){review.undated++;continue}if(date<period.from||date>period.to)continue;
    present.add(`${date}:${card.memberId}:${card.projectId}`);
    if(!card.outAt){review.running++;continue}const hours=Number(card.hours);if(card.hours==null||typeof card.hours==='boolean'||String(card.hours).trim()===''||!Number.isFinite(hours)||hours<0||!dateAt(card.outAt,period.timeZone)||Date.parse(card.outAt)<=Date.parse(card.inAt)){review.invalid++;continue}
    if(!isApproved(card)){if(String(card.status||'').toLowerCase()==='submitted')review.submitted++;else review.draft++;continue}
    const member=(db.team||[]).find(m=>Number(m.id)===Number(card.memberId)),project=(db.projects||[]).find(p=>Number(p.id)===Number(card.projectId));
    const record={id:card.id,memberId:card.memberId,person:member?.name||'Unknown person',projectId:card.projectId,project:project?.name||card.activityName||'Company time',date,inAt:card.inAt,outAt:card.outAt,hours,approvedBy:card.approvedBy||'',approvedAt:card.approvedAt||null};records.push(record);
    const person=people.get(String(card.memberId))||{memberId:card.memberId,name:record.person,hours:0,cardCount:0};person.hours+=hours;person.cardCount++;people.set(String(card.memberId),person);
  }
  const expected=new Set();for(const assignment of assignments){if(!validDate(assignment.date)||assignment.date<period.from||assignment.date>period.to)continue;for(const memberId of assignment.memberIds||[])expected.add(`${assignment.date}:${memberId}:${assignment.projectId}`)}
  const missingEntries=[...expected].filter(key=>!present.has(key)).map(key=>{const [date,memberId,projectId]=key.split(':');return{date,memberId,projectId,person:(db.team||[]).find(m=>String(m.id)===memberId)?.name||'Unknown person',project:(db.projects||[]).find(p=>String(p.id)===projectId)?.name||'Scheduled work'}});
  review.missingScheduledEntries=missingEntries.length;
  records.sort((a,b)=>a.date.localeCompare(b.date)||String(a.memberId).localeCompare(String(b.memberId))||String(a.id).localeCompare(String(b.id)));
  const rounded=n=>Math.round(n*100)/100;return{period:publicPeriod(period),datePolicy:'Company timezone; full overnight card belongs to its clock-in date; inclusive start/end dates.',approvedHours:rounded(records.reduce((n,r)=>n+r.hours,0)),approvedCount:records.length,people:[...people.values()].map(p=>({...p,hours:rounded(p.hours)})).sort((a,b)=>String(a.memberId).localeCompare(String(b.memberId))),review,missingEntries,ready:Object.values(review).every(n=>n===0),records};
}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}
function capture(db,period,input,actor,options={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['supersedesId','reason'].includes(k)))fail('Use only export version and correction reason');
  const current=summary(db,period,options);if(!current.ready)fail('Resolve running, unapproved, invalid or missing scheduled time before ending this period',409);
  const latest=(db.payPeriodExports||[]).filter(e=>e.periodId===period.id).at(-1),reason=String(input.reason||'').trim();
  if(latest&&input.supersedesId!==latest.id)fail('Use the latest export version for a correction',409);if(!latest&&input.supersedesId)fail('Prior export does not belong to this period',409);if(latest&&(!reason||reason.length>1000))fail('A corrected export needs a reason of 1-1000 characters');
  const record={id:crypto.randomUUID(),companyId:db.company.id,periodId:period.id,version:(latest?.version||0)+1,supersedesId:latest?.id||null,reason,createdAt:new Date().toISOString(),createdBy:actor.name,sourceHash:hash(current),summary:structuredClone(current)};
  db.payPeriodExports ||= [];db.payPeriodExports.push(record);period.status='closed';period.closedAt=record.createdAt;db.auditLog ||= [];db.auditLog.push({id:crypto.randomUUID(),type:'pay_period_export_created',periodId:period.id,exportId:record.id,actor:actor.name,at:record.createdAt,detail:`Fixed approved-hours export v${record.version}; ${reason||'period ended'}`});return record;
}
function csv(record){const p=record.summary.period,rows=[['Period','Start','End','Timezone','Version','Person','Job','Work date','In','Out','Approved hours','Approved by']];for(const r of record.summary.records)rows.push([p.label,p.from,p.to,p.timeZone,record.version,r.person,r.project,r.date,r.inAt,r.outAt,r.hours,r.approvedBy]);return rows.map(row=>row.map(value=>csvCell(value)).join(',')).join('\r\n')+'\r\n'}
module.exports={completeCard,validDate,dateAt,savePeriod,summary,capture,csv,hash};
