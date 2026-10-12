'use strict';
(function(){
 const extracted=['summary','labor','quantity','issue','next','originalLanguage','englishTranslation','source','warning'];
 const fields=['project','projectId','sourceAssignmentId','dateIso','status','crew','foreman','notes','weather','temperature','materials','equipment','delays','safety','signature','summary','labor','quantity','issue','next','noteLanguage','englishTranslation','productionEntries','laborEntries','workSuggestions','templateId','templateVersion','customFields','reportType','safetyItems','safetyTalk','safetyTalkAttendees','safetyInspection','safetyIncident','noSafetyObservations','laborExclusions'];
 const text=value=>Object.fromEntries(extracted.filter(key=>typeof value?.[key]==='string').map(key=>[key,value[key]]));
 function body(raw,{status=null}={}){const report=Object.fromEntries(fields.filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]]));if(status!==null)report.status=status;report.extracted=text(raw.extracted||raw);return report;}
 function plan(route,report,files,caption,tags){return JSON.stringify([route,report,Array.from(files||[],file=>[file.name,file.type,file.size,file.lastModified]),caption,tags]);}
 function form(root){return JSON.stringify(Array.from(root?.querySelectorAll('input,textarea,select')||[],node=>[node.id,node.name,node.type,node.value,node.checked,Array.from(node.files||[],file=>[file.name,file.type,file.size,file.lastModified])]));}
 const safety=report=>['reportType','safetyItems','safetyTalk','safetyTalkAttendees','safetyInspection','safetyIncident','noSafetyObservations'].some(name=>Object.hasOwn(report,name));
 const value={body,text,plan,form,safety};if(typeof module!=='undefined'&&module.exports){module.exports=value;return;}window.PDLNormalReport=value;
})();
