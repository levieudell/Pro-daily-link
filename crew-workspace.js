(function(root){
  'use strict';
  const key=value=>String(value??'').trim().toLowerCase();
  const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
  function summarize(crew,{team=[],projects=[],reports=[],assignments=[],workdays=[],today='',timezone='UTC',countedHours=null}={}){
    const projectMap=new Map(projects.map(project=>[String(project.id),project]));
    const assigned=row=>row&&((row.crewId!=null&&crew.id!=null)?same(row.crewId,crew.id):key(row.crew)===key(crew.name));
    const crewAssignments=assignments.filter(row=>!row.deletedAt&&assigned(row)&&projectMap.has(String(row.projectId)));
    const assignmentIds=new Set(crewAssignments.map(row=>String(row.id)));
    const matches=row=>row&&(row.crewId!=null||key(row.crew)?assigned(row):(row.sourceAssignmentId!=null&&assignmentIds.has(String(row.sourceAssignmentId)))||(row.assignmentId!=null&&assignmentIds.has(String(row.assignmentId))));
    const projectFor=report=>report.projectId!=null?projectMap.get(String(report.projectId)):projects[report.project];
    const seen=new Set();
    const dailies=reports.filter(report=>{
      if(report.deletedAt||!matches(report)||!projectFor(report)||seen.has(String(report.id)))return false;
      seen.add(String(report.id));return true;
    });
    const members=team.filter(member=>key(member.crew)===key(crew.name));
    const memberIds=new Set(members.map(member=>String(member.id)));
    const working=workdays.filter(row=>!row.deletedAt&&row.status==='active'&&!row.endedAt&&projectMap.has(String(row.projectId))&&(row.memberIds||[]).some(id=>memberIds.has(String(id))));
    const reportWorkdayIds=new Set(dailies.map(row=>row.workdayId).filter(id=>id!=null).map(String));
    const day=row=>{
      if(/^\d{4}-\d{2}-\d{2}$/.test(row.dateIso||row.date||''))return row.dateIso||row.date;
      if(!row.startedAt||!Number.isFinite(Date.parse(row.startedAt)))return '';
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(row.startedAt));
      return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
    };
    const jobs=new Map();
    function job(project,date){
      if(!project)return null;
      const id=String(project.id);if(!jobs.has(id))jobs.set(id,{project,firstDate:date,lastDate:date,days:new Set(),dailyCount:0,approvedHours:0});
      const row=jobs.get(id);if(date){row.days.add(date);if(!row.firstDate||date<row.firstDate)row.firstDate=date;if(!row.lastDate||date>row.lastDate)row.lastDate=date;}return row;
    }
    let approvedHours=0;
    for(const report of dailies){
      if(report.status==='Draft')continue;
      const row=job(projectFor(report),day(report));row.dailyCount++;
      if(report.status==='Approved'&&countedHours){
        const hours=[...new Set((report.laborEntries||[]).map(entry=>entry.memberId))].reduce((sum,id)=>sum+Math.max(0,Number(countedHours(report,id))||0),0);
        row.approvedHours+=hours;approvedHours+=hours;
      }
    }
    for(const workday of workdays){
      if(workday.deletedAt||!workday.endedAt||!(matches(workday)||reportWorkdayIds.has(String(workday.id))))continue;
      job(projectMap.get(String(workday.projectId)),day(workday));
    }
    const upcoming=crewAssignments.filter(row=>row.date>=today&&!['cancelled','canceled'].includes(key(row.status))).sort((a,b)=>(a.date+(a.start||'')).localeCompare(b.date+(b.start||'')));
    return {members,working,upcoming,approvedHours,jobs:[...jobs.values()].map(row=>({...row,days:row.days.size})).sort((a,b)=>b.lastDate.localeCompare(a.lastDate)),dailies:[...dailies].sort((a,b)=>day(b).localeCompare(day(a))),needsReview:dailies.filter(row=>['Draft','Needs review','Missing data','Submitted'].includes(row.status)),projectFor,day};
  }
  const api={summarize};if(typeof module==='object'&&module.exports)module.exports=api;else root.PDLCrewWorkspace=api;
})(typeof globalThis==='object'?globalThis:this);
