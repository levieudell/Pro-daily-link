'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.EmployeeRoster=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const isArchived=member=>member?.archived===true||Boolean(member?.archivedAt);
  const version=member=>Number.isSafeInteger(member?.archiveVersion)&&member.archiveVersion>=0?member.archiveVersion:0;
  function visible(team,view='active'){return team.filter(member=>view==='all'||(view==='archived'?isArchived(member):!isArchived(member)));}
  function targets(team,assignment){const retained=new Set((assignment?.memberIds||[]).map(Number));return team.filter(member=>!isArchived(member)||retained.has(Number(member.id)));}
  function scheduleMembers(team,assignments,dates){return team.filter(member=>!isArchived(member)||assignments.some(row=>dates.has(row.date)&&(row.memberIds||[]).map(Number).includes(Number(member.id))));}
  function assignmentError(team,memberIds,{source=null,date='',today='',move=false}={}){
    const archived=team.filter(member=>isArchived(member)&&memberIds.map(Number).includes(Number(member.id)));
    if(!archived.length)return null;
    // An existing past shift may be corrected without replacing its historical people.
    if(!move&&source&&date===source.date&&date<today&&archived.every(member=>(source.memberIds||[]).map(Number).includes(Number(member.id))))return null;
    return 'Archived employees cannot receive new or moved assignments. Restore the employee first.';
  }
  return {isArchived,version,visible,targets,scheduleMembers,assignmentError};
});
