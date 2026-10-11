(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLProjectSchedule=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Linked project-task scheduling. Tasks depend on predecessors; dates are
  // always computed: a task starts the next business day after its latest
  // predecessor ends (tasks with no predecessor start at the project anchor
  // date, typically the project start date). Editing a duration or a link
  // recascades every downstream task. Cycles are rejected.
  const MS_PER_DAY=86400000;
  const STATUS=['not-started','in-progress','done'];

  function toDate(iso){const date=new Date(String(iso).slice(0,10)+'T12:00:00');return isNaN(date)?null:date}
  function toIso(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
  function isBusinessDay(date){const day=date.getDay();return day!==0&&day!==6}
  function nextBusinessDay(iso){let date=toDate(iso);if(!date)return null;do date=new Date(date.getTime()+MS_PER_DAY);while(!isBusinessDay(date));return toIso(date)}
  function addBusinessDays(iso,days){let date=toDate(iso);if(!date||!(days>0))return toDate(iso)?toIso(toDate(iso)):null;for(let i=1;i<days;i++)date=new Date(toDate(nextBusinessDay(toIso(date))).getTime());return toIso(date)}
  function businessDaysBetween(fromIso,toIso){let date=toDate(fromIso),end=toDate(toIso),count=0;if(!date||!end||end<date)return 0;while(date<=end){if(isBusinessDay(date))count++;date=new Date(date.getTime()+MS_PER_DAY)}return count}

  function normalizeDuration(value){const days=Math.round(Number(value));return days>=1&&days<=365?days:null}
  function normalizeStatus(value){return STATUS.includes(value)?value:'not-started'}

  // Validate one raw input. teamIds (when provided) constrains memberIds.
  function validate(input,existing,teamIds){
    const name=String(input.name??existing?.name??'').trim();
    if(!name)return{error:'A task name is required'};
    if(name.length>160)return{error:'Keep the task name under 160 characters'};
    const durationDays=normalizeDuration(input.durationDays??existing?.durationDays);
    if(!durationDays)return{error:'Duration must be 1–365 working days'};
    const predecessorIds=[...new Set((Array.isArray(input.predecessorIds)?input.predecessorIds:existing?.predecessorIds||[]).map(Number).filter(id=>existing?Number(existing.id)!==id:id>0))];
    const memberIds=[...new Set((Array.isArray(input.memberIds)?input.memberIds:existing?.memberIds||[]).map(Number).filter(id=>id>0))];
    if(teamIds&&memberIds.some(id=>!teamIds.has(id)))return{error:'Choose people from this company’s team'};
    const crew=String(input.crew??existing?.crew??'').trim().slice(0,80);
    return{value:{name:name.slice(0,160),durationDays,predecessorIds,memberIds,crew,status:normalizeStatus(input.status??existing?.status)}};
  }

  // Topological order; returns {order} or {cycle:[ids]}.
  function topoOrder(tasks){
    const byId=new Map(tasks.map(task=>[Number(task.id),task])),indegree=new Map(tasks.map(task=>[Number(task.id),0])),downstream=new Map();
    for(const task of tasks)for(const pred of task.predecessorIds||[]){if(!byId.has(Number(pred)))continue;indegree.set(Number(task.id),(indegree.get(Number(task.id))||0)+1);const list=downstream.get(Number(pred))||[];list.push(Number(task.id));downstream.set(Number(pred),list)}
    const queue=tasks.filter(task=>!indegree.get(Number(task.id))).map(task=>Number(task.id)),order=[];
    while(queue.length){const id=queue.shift();order.push(id);for(const next of downstream.get(id)||[]){indegree.set(next,indegree.get(next)-1);if(!indegree.get(next))queue.push(next)}}
    if(order.length<tasks.length)return{cycle:tasks.map(task=>Number(task.id)).filter(id=>!order.includes(id))};
    return{order};
  }

  // Compute dates for every task. anchorDate (usually the project start date)
  // is where no-predecessor tasks begin; defaults to today if missing.
  function scheduleTasks(tasks,anchorDate){
    const list=(tasks||[]).map(task=>({...task,id:Number(task.id),durationDays:normalizeDuration(task.durationDays)||1,predecessorIds:(task.predecessorIds||[]).map(Number).filter(id=>listContains(tasks,id))}));
    const {order,cycle}=topoOrder(list);
    if(cycle)return{error:'Those tasks link back on themselves. Remove a dependency to break the loop.',cycle};
    const anchor=toDate(anchorDate)?String(anchorDate).slice(0,10):toIso(new Date()),byId=new Map(list.map(task=>[Number(task.id),task])),computed=new Map();
    const scheduled=list.map(task=>({...task}));
    for(const id of order){
      const task=byId.get(id),preds=(task.predecessorIds||[]).map(Number).filter(predId=>computed.has(predId));
      const start=preds.length?nextBusinessDay(computed.get(preds.reduce((a,b)=>Date.parse(computed.get(b).end)>Date.parse(computed.get(a).end)?b:a)).end):anchor;
      const end=addBusinessDays(start,task.durationDays);
      const dates={startDate:start,endDate:end};
      computed.set(id,{start:start,end:end});
      Object.assign(scheduled.find(row=>Number(row.id)===id),dates);
    }
    return{tasks:scheduled};
  }
  function listContains(tasks,id){return (tasks||[]).some(task=>Number(task.id)===Number(id))}

  // Which tasks changed dates between two scheduled snapshots.
  function changedDateIds(before,after){const prev=new Map((before||[]).map(task=>[Number(task.id),`${task.startDate}|${task.endDate}`]));return (after||[]).filter(task=>prev.get(Number(task.id))!==`${task.startDate}|${task.endDate}`).map(task=>Number(task.id))}

  return{MS_PER_DAY,STATUS,toIso,toDate,isBusinessDay,nextBusinessDay,addBusinessDays,businessDaysBetween,validate,topoOrder,scheduleTasks,changedDateIds};
});
