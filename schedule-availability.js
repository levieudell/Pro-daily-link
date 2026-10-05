(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLScheduleAvailability=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Time-off requests use inclusive company calendar dates, never UTC instants.
  function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value}
  function approved(requests,memberIds){
    const allowed=new Set((memberIds||[]).map(Number));
    return (requests||[]).filter(row=>row.status==='approved'&&allowed.has(Number(row.memberId))&&validDate(row.startDate)&&validDate(row.endDate)&&row.endDate>=row.startDate)
      .map(row=>({memberId:Number(row.memberId),startDate:row.startDate,endDate:row.endDate}));
  }
  function onDate(rows,memberId,date){return validDate(date)&&(rows||[]).some(row=>Number(row.memberId)===Number(memberId)&&row.startDate<=date&&row.endDate>=date)}
  function conflicts(rows,memberIds,dates){
    const conflictMemberIds=[],conflictDates=[];
    for(const date of dates)for(const id of memberIds)if(onDate(rows,id,date)){if(!conflictMemberIds.includes(Number(id)))conflictMemberIds.push(Number(id));if(!conflictDates.includes(date))conflictDates.push(date)}
    return {conflictMemberIds,conflictDates:conflictDates.sort()};
  }
  function summarize(rows,members,days){
    const dates=[...new Set((days||[]).map(day=>typeof day==='string'?day:day.date).filter(validDate))].sort();
    return (members||[]).flatMap(member=>{
      const absent=dates.filter(date=>onDate(rows,member.id,date));
      if(!absent.length)return [];
      const ranges=[];
      for(const date of absent){const last=ranges.at(-1);if(last&&Date.parse(`${date}T12:00:00Z`)-Date.parse(`${last.endDate}T12:00:00Z`)===86400000)last.endDate=date;else ranges.push({startDate:date,endDate:date})}
      return [{memberId:Number(member.id),name:String(member.name||'Team member'),ranges}];
    });
  }
  return {validDate,approved,onDate,conflicts,summarize};
});
