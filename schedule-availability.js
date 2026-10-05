(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLScheduleAvailability=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Dates and times are company-local wall-clock values, never UTC instants.
  // Legacy requests without allDay stay inclusive all-day date ranges.
  function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value}
  function validTime(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)}
  function validRange(row){
    return row&&validDate(row.startDate)&&validDate(row.endDate)&&row.endDate>=row.startDate&&
      (row.allDay===undefined||row.allDay===true||row.allDay===false&&row.startDate===row.endDate&&validTime(row.startTime)&&validTime(row.endTime)&&row.startTime<row.endTime);
  }
  function approved(requests,memberIds){
    const allowed=new Set((memberIds||[]).map(Number));
    return (requests||[]).filter(row=>row?.status==='approved'&&allowed.has(Number(row.memberId))&&validRange(row))
      .map(row=>({memberId:Number(row.memberId),startDate:row.startDate,endDate:row.endDate,...(row.allDay===false?{allDay:false,startTime:row.startTime,endTime:row.endTime}:{})}));
  }
  function onDate(rows,memberId,date,start,end){
    if(!validDate(date))return false;
    const bounded=start!==undefined||end!==undefined;
    if(bounded&&(!validTime(start)||!validTime(end)||start>=end))return false;
    return (rows||[]).some(row=>validRange(row)&&Number(row.memberId)===Number(memberId)&&row.startDate<=date&&row.endDate>=date&&
      (row.allDay!==false||!bounded||start<row.endTime&&end>row.startTime));
  }
  function conflicts(rows,memberIds,dates,start,end){
    const conflictMemberIds=[],conflictDates=[];
    for(const date of dates)for(const id of memberIds)if(onDate(rows,id,date,start,end)){if(!conflictMemberIds.includes(Number(id)))conflictMemberIds.push(Number(id));if(!conflictDates.includes(date))conflictDates.push(date)}
    return {conflictMemberIds,conflictDates:conflictDates.sort()};
  }
  function summarize(rows,members,days){
    const dates=[...new Set((days||[]).map(day=>typeof day==='string'?day:day.date).filter(validDate))].sort();
    return (members||[]).flatMap(member=>{
      const memberRows=(rows||[]).filter(row=>validRange(row)&&Number(row.memberId)===Number(member.id)),allDayRows=memberRows.filter(row=>row.allDay!==false),ranges=[];
      for(const date of dates){
        if(onDate(allDayRows,member.id,date)){
          const last=ranges.at(-1);
          if(last&&last.allDay!==false&&Date.parse(`${date}T12:00:00Z`)-Date.parse(`${last.endDate}T12:00:00Z`)===86400000)last.endDate=date;
          else ranges.push({startDate:date,endDate:date});
          continue;
        }
        const intervals=memberRows.filter(row=>row.allDay===false&&row.startDate===date).sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.endTime.localeCompare(b.endTime));
        for(const row of intervals){
          const last=ranges.at(-1);
          if(last?.allDay===false&&last.startDate===date&&row.startTime<=last.endTime){if(row.endTime>last.endTime)last.endTime=row.endTime}
          else ranges.push({startDate:date,endDate:date,allDay:false,startTime:row.startTime,endTime:row.endTime});
        }
      }
      return ranges.length?[{memberId:Number(member.id),name:String(member.name||'Team member'),ranges}]:[];
    });
  }
  return {validDate,validTime,approved,onDate,conflicts,summarize};
});
