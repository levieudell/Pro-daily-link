(function(root){
  'use strict';
  const sameId=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
  const hours=(report,memberId)=>(report.laborEntries||[]).filter(row=>sameId(row.memberId,memberId)).reduce((sum,row)=>sum+(Number(row.hours)||0),0);
  function memberIntervals(report,memberId,{workdays=[],timeCards=[]}){
    const workday=workdays.find(row=>sameId(row.id,report.workdayId)&&!row.deletedAt&&(row.memberIds||[]).some(id=>sameId(id,memberId)));
    const cards=timeCards.filter(row=>!row.deletedAt&&sameId(row.memberId,memberId)&&(sameId(row.reportId,report.id)||sameId(row.workdayId,workday?.id)));
    const rows=cards.length?cards.map(row=>[row.inAt,row.outAt]):workday?[[workday.startedAt,workday.endedAt]]:[];
    const intervals=rows.map(([start,end])=>[Date.parse(start),Date.parse(end)]);
    return intervals.length&&intervals.every(([start,end])=>Number.isFinite(start)&&Number.isFinite(end)&&end>start)?intervals:[];
  }
  function review(report,{reports=[],team=[],workdays=[],timeCards=[]}={}){
    if(!report?.dateIso||report.project==null)return [];
    const warnings=[];
    for(const memberId of new Set((report.laborEntries||[]).filter(row=>Number(row.hours)>0).map(row=>String(row.memberId)))){
      const current=memberIntervals(report,memberId,{workdays,timeCards});
      const others=reports.filter(other=>!sameId(other.id,report.id)&&!other.deletedAt&&other.project===report.project&&other.dateIso===report.dateIso&&hours(other,memberId)>0).filter(other=>{
        const intervals=memberIntervals(other,memberId,{workdays,timeCards});
        // Known separate shifts are legitimate. Missing shift evidence requires review,
        // rather than silently dropping an explicitly entered crew member.
        return !current.length||!intervals.length||current.some(([a,b])=>intervals.some(([c,d])=>a<d&&c<b));
      });
      if(others.length)warnings.push({memberId,memberName:team.find(row=>sameId(row.id,memberId))?.name||`Team member ${memberId}`,hours:hours(report,memberId),otherReports:others.map(other=>({id:other.id,hours:hours(other,memberId),status:other.status})),otherHours:Math.round(others.reduce((sum,other)=>sum+hours(other,memberId),0)*100)/100});
    }
    return warnings;
  }
  const api={review};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLReportLaborReview=api;
})(typeof globalThis==='object'?globalThis:this);
