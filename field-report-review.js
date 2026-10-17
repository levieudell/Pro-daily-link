'use strict';
const scope=require('./field-daily-scope');
const finite=(value,max=24)=>value==null||value===''||Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=max;
function invalidLabor(input){
 for(const key of ['laborEntries','laborEntered','reportedLabor'])if(Object.hasOwn(input||{},key)){
  if(!Array.isArray(input[key]))return true;
  const ids=new Set();for(const row of input[key]){const id=Number(row?.memberId);if(!row||!Number.isSafeInteger(id)||id<=0||ids.has(id)||!finite(row.hours))return true;ids.add(id)}
 }
 if(Object.hasOwn(input||{},'productionEntries')&&!Array.isArray(input.productionEntries))return true;
 return (input?.productionEntries||[]).some(row=>!row||!finite(row.laborHours,480)||!finite(row.laborMinutes,28800));
}
function review(report,input,measuredClock=[]){
 const reported=(Array.isArray(input?.reportedLabor)?input.reportedLabor:Array.isArray(input?.laborEntries)?input.laborEntries:report.officeReview?.reportedLabor||null);
 const reportedLabor=reported?reported.map(row=>({memberId:Number(row.memberId),hours:row.hours==null||row.hours===''?null:Number(row.hours)})):null;
 const reasons=scope.narrativeWarnings(report.notes,report.summary);
 const known=(reportedLabor||report.laborEntries||[]).filter(row=>row.hours!=null&&row.hours!==''&&Number.isFinite(Number(row.hours)));
 const reportedTotal=known.reduce((sum,row)=>sum+Number(row.hours),0);
 if(!known.length||!(reportedTotal>0))reasons.push({code:'labor_missing',message:'Crew hours are not confirmed. Office review is needed; missing hours are not verified zero.'});
 const allocation=(report.productionEntries||[]).reduce((sum,row)=>sum+(Number(row.laborHours)||0),0)+(Array.isArray(input?.confirmedExtras)?input.confirmedExtras.filter(row=>row.decision==='extra'):(report.extraWork||[])).reduce((sum,row)=>sum+(Number(row.laborHours)||0),0);
 if(known.length&&Math.abs(reportedTotal-allocation)>.01)reasons.push({code:'labor_allocation_mismatch',message:'Reported crew hours and work-line hours differ. Office must review the allocation.'});
 const clockTotals=new Map();for(const clock of measuredClock)clockTotals.set(clock.memberId,(clockTotals.get(clock.memberId)||0)+clock.seconds);
 if([...clockTotals].some(([memberId,seconds])=>{const row=known.find(row=>row.memberId===memberId);return row&&Math.abs(Number(row.hours)-seconds/3600)>.015}))reasons.push({code:'clock_reported_mismatch',message:'Reported hours differ from measured clock time. Punches and payroll hours were retained separately.'});
 if(!measuredClock.length&&known.length)reasons.push({code:'clock_unavailable',message:'No measured closed clock time is available for these reported hours. Office should verify them; missing clock data is not zero time.'});
 return {status:reasons.length?'Needs review':'No discrepancy detected',reasons,reportedLabor,measuredClock};
}
module.exports={invalidLabor,review};
