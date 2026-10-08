(function(root){
  'use strict';
  const id=value=>value==null||String(value).trim()===''?null:String(value);
  const key=(date,projectId,memberId)=>JSON.stringify([date,id(projectId),id(memberId)]);
  function review({assignments=[],reports=[],projects=[],memberIds=[]}={}){
    const visible=new Set(memberIds.map(id)),groups=new Map();
    assignments.forEach((assignment,index)=>{
      if(assignment.deletedAt||!assignment.date||id(assignment.projectId)==null)return;
      for(const memberId of new Set((assignment.memberIds||[]).map(id))){
        if(memberId==null||!visible.has(memberId))continue;
        const groupKey=key(assignment.date,assignment.projectId,memberId);
        const group=groups.get(groupKey)||{date:assignment.date,projectId:assignment.projectId,memberId,hours:0,assignments:new Set(),reports:new Set()};
        group.assignments.add(index);groups.set(groupKey,group);
      }
    });
    const seen=new Set();
    reports.forEach((report,index)=>{
      if(report.deletedAt||report.status!=='Approved'||!report.dateIso)return;
      const projectId=projects[report.project]?.id;
      if(id(projectId)==null)return;
      const byMember=new Map();
      for(const entry of report.laborEntries||[]){const memberId=id(entry.memberId),hours=Number(entry.hours);if(memberId!=null&&Number.isFinite(hours))byMember.set(memberId,(byMember.get(memberId)||0)+hours)}
      for(const [memberId,hours] of byMember){
        const group=groups.get(key(report.dateIso,projectId,memberId));if(!group)continue;
        const reportKey=id(report.id)==null?'row:'+index:'id:'+id(report.id),evidenceKey=JSON.stringify([reportKey,memberId]);
        if(seen.has(evidenceKey))continue;seen.add(evidenceKey);group.hours+=hours;group.reports.add(reportKey);
      }
    });
    const rows=[...groups.values()].map(group=>({date:group.date,projectId:group.projectId,memberId:group.memberId,hours:group.hours,assignmentCount:group.assignments.size,reportCount:group.reports.size,unallocated:group.hours>0&&group.assignments.size>1}));
    return {hours:rows.reduce((sum,group)=>sum+group.hours,0),groups:rows,unallocatedGroups:rows.filter(group=>group.unallocated).length};
  }
  const api={review};if(typeof module==='object'&&module.exports)module.exports=api;else root.PDLScheduleApprovedLabor=api;
})(typeof globalThis==='object'?globalThis:this);
