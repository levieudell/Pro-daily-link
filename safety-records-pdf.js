'use strict';
const fs=require('node:fs');
const path=require('node:path');

const displayDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?`${value.slice(5,7)}/${value.slice(8,10)}/${value.slice(0,4)}`:String(value||'');

module.exports=async function safetyRecordsPdf({companyName,from,to,meetings,days,projects}) {
  const PDFDocument=require('pdfkit');
  const doc=new PDFDocument({margin:40,bufferPages:true,size:'LETTER'}),chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  for(const [name,file] of [['Inter','inter-400.ttf'],['Bold','inter-700.ttf'],['Anton','anton-400.ttf']])doc.registerFont(name,path.join(__dirname,'assets','fonts',file));
  const logo=fs.readFileSync(path.join(__dirname,'assets','pdl-monogram.svg'),'utf8');
  const box=logo.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number),transform=logo.match(/translate\(([^,]+),([^\)]+)\) scale\(([^,]+),([^\)]+)\)/).slice(1).map(Number);
  const header=()=>{
    doc.rect(0,0,612,76).fill('#000000');doc.rect(0,76,612,3).fill('#FF6600');
    doc.save().translate(40,14).scale(46/box[3]).translate(-box[0],-box[1]).translate(transform[0],transform[1]).scale(transform[2],transform[3]);
    for(const match of logo.matchAll(/<path d="([^"]+)"/g))doc.path(match[1]).fill('#FFFFFF');doc.restore();
    doc.font('Anton').fontSize(25).fillColor('#FFFFFF').text('SAFETY RECORDS',120,18,{lineBreak:false});
    doc.font('Inter').fontSize(10).text('Murder the Guesswork',120,50,{lineBreak:false});doc.fillColor('#000000');doc.x=40;doc.y=98;
  };
  header();doc.on('pageAdded',header);
  const line=(label,value)=>{doc.font('Bold').fontSize(10).text(label);doc.font('Inter').fontSize(10).text(String(value || 'Not recorded'),{width:532});doc.moveDown(.5);};
  const title=value=>{if(doc.y>640)doc.addPage();doc.moveDown(.5).font('Anton').fontSize(18).text(value,{width:532});doc.moveDown(.5);};
  line('Company',companyName);line('Record dates',`${displayDate(from)} – ${displayDate(to)}`);
  line('Contents',`${meetings.length} scheduled/recorded meetings · ${days.length} project safety days. Cancelled and incomplete records are identified. Attendance is reported unless an individual acknowledgment is listed.`);
  if(!meetings.length&&!days.length)line('No records','No safety records were found for this range.');
  for(const row of meetings){
    title(`${row.kind==='committee'?'COMMITTEE':row.kind==='job-start'?'JOB START':'CREW TALK'} · ${displayDate(row.date)}`);
    line('Topic / status',`${row.topic.title} · ${row.status.toUpperCase()}`);line('Project',row.projectName);line('Presenter',row.presenter);
    line('Topic version',`${row.topic.origin || 'Company'} · revision ${row.topic.revision} · ${row.topic.language}`);line('Discussion guide used',row.topic.content);if(row.topic.source)line('Reference',row.topic.source);
    line('Invited',row.invited.map(person=>person.name).join(', '));line('Recorded present',row.attendees.map(person=>person.name).join(', '));
    line(row.status==='completed'?'Not recorded present':'Attendance not yet recorded',row.invited.filter(person=>!row.attendees.some(attendee=>attendee.memberId===person.memberId)).map(person=>person.name).join(', ')||'None');
    line('Individual acknowledgments',row.acknowledgments.map(person=>`${person.name} · ${person.at}`).join('\n')||'None recorded');
    line('Hazards and discussion',row.discussion);if(row.kind==='committee'){line('Recommendations',row.recommendations);line('Management response',row.managementResponse);}
    for(const action of row.actions||[])line(`Action · ${action.status}`,`${action.observation}\nOwner: ${action.owner} · Due: ${displayDate(action.dueDate)}\n${action.evidence||'No correction/verification recorded.'}`);
    for(const correction of row.corrections||[])line('Prior record preserved',`${correction.at} · ${correction.by} · ${correction.reason}\n${JSON.stringify(correction.before)}`);
    line('Audit trail',(row.history||[]).map(event=>`${event.at} · ${event.by} · ${event.action}${event.detail?' · '+event.detail:''}`).join('\n'));
  }
  for(const day of days){
    title(`PROJECT SAFETY · ${displayDate(day.date)}`);line('Project',projects.find(row=>Number(row.id)===day.projectId)?.name||String(day.projectId));
    for(const check of day.checks||[])line(`${check.title} · ${check.status}`,`${check.notes||''}\n${check.recordedBy||check.updatedBy||check.inspector||''} ${check.updatedAt||''}`);
    for(const talk of day.talks||[]) {line(`Crew talk${talk.voidedAt?' · VOIDED':''}`,`${talk.topic}\n${talk.notes||talk.outline||''}\nPresenter: ${talk.presenter||''}\nReported present: ${(talk.attendees||[]).map(person=>person.name||person).join(', ')}`);if(talk.initial)line('Original talk',JSON.stringify(talk.initial));if(talk.corrections?.length)line('Talk corrections',JSON.stringify(talk.corrections));if(talk.voidReason)line('Void reason',talk.voidReason);}
    for(const hazard of day.hazards||[])line(`Hazard · ${hazard.status}`,`${hazard.observation}\nAction: ${hazard.action||''}\nOwner: ${hazard.owner||''} · Due: ${displayDate(hazard.dueDate)}\nVerification: ${hazard.verification||''}${hazard.voidReason?'\nRecorded in error: '+hazard.voidReason+'\nCorrection by: '+(hazard.voidedBy||''):''}`);
    if(day.history?.length)line('Project audit trail',day.history.map(event=>`${event.at||''} · ${event.by||''} · ${event.action||''}\n${JSON.stringify({before:event.before,after:event.after})}`).join('\n'));
  }
  const pages=doc.bufferedPageRange();for(let index=0;index<pages.count;index++){doc.switchToPage(index);doc.page.margins.bottom=0;doc.font('Inter').fontSize(8).fillColor('#000000').text(`Pro Daily Link · Recorded evidence, not a compliance certification · ${index+1}/${pages.count}`,40,754,{lineBreak:false});}
  doc.end();return done;
};
