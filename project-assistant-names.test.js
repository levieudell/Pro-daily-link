'use strict';
const assert=require('node:assert/strict');
const {projectsFor,peopleFor,relativeDate}=require('./project-assistant-names');
const {createChat}=require('./project-assistant-chat');
const projects=[{id:101,name:'Market Street Reno'}],members=[{id:11,name:'Chloe'},{id:12,name:'Andi'}];
const context={project:projects[0],members,timezone:'America/Los_Angeles',today:'2026-10-07',capabilities:{schedule:true}};
const sentence='Schedule Chloe Andy at market Street tomorrow';
function initial(rows=projects,ctx=context,text=sentence){const chat=createChat({projects:rows});const result=chat.consume(text);if(result.needsContext)chat.hydrate(ctx);return chat;}
for(const text of [sentence,'Schedule Chloe, Andi at MARKET STREET tomorrow','Schedule Chloe and Andi at Market St. tomorrow'])assert.equal(projectsFor(text,projects).id,101);
assert.equal(projectsFor('Schedule Chloe at market tomorrow',projects).id,null,'one generic project token requires candidate clarification');
assert.equal(projectsFor(sentence,[...projects,{id:102,name:'Market Street Annex'}]).id,null);
assert.equal(projectsFor('Schedule Chloe at Market Street or Unknown tomorrow',projects).id,null);
assert.equal(projectsFor('Schedule Chloe at Market Street and project ID 999 tomorrow',projects).id,null);
assert.equal(projectsFor('Schedule Chloe at Foreign Site tomorrow',projects).choices.length,0);
assert.equal(projectsFor('Schedule Chloe at Wood and Stone tomorrow',[{id:202,name:'Wood and Stone'}]).id,202,'and inside an exact authorized project label is data');
assert.deepEqual(peopleFor('CHLOE & ANDI',members).ids,[11,12]);
assert.deepEqual(peopleFor('Chloe Andy',members).choices,[[11,12]]);assert.equal(peopleFor('Chloe Andy',members).ids,null);
assert.equal(peopleFor('Chloe unknown',members).choices.length,0,'unknown words cannot be dropped');
assert.equal(peopleFor('李明',[{id:1,name:'张伟'}]).choices.length,0);assert.equal(peopleFor('🚧',[{id:1,name:'张伟'}]).choices.length,0);assert.equal(peopleFor('Chloe 张伟',[{id:11,name:'Chloe'}]).choices.length,0,'unknown non-Latin name words remain present');assert.deepEqual(peopleFor('张伟',[{id:1,name:'张伟'}]).ids,[1]);
assert.equal(peopleFor('Chloe and ID 999',members).choices.length,0);
assert.equal(peopleFor('Chloe or Andi',members).ids,null);
const twoSpellings=[...members,{id:13,name:'Andy'}];assert.equal(peopleFor('Chloe Andy',twoSpellings).choices.length,2);assert.deepEqual(peopleFor('Chloe and Andy',twoSpellings).ids,[11,13]);
const duplicate=[{id:11,name:'Chloe Vale'},{id:12,name:'Andi'},{id:14,name:'Chloe Jones'}];assert.equal(peopleFor('Chloe and Andi',duplicate).choices.length,2);assert.equal(peopleFor('Chloe and Andi',duplicate).ids,null);assert.deepEqual(peopleFor('Chloe Jones and Andi',duplicate).ids,[14,12]);
for(const [today,next]of [['2026-10-07','2026-10-08'],['2028-02-28','2028-02-29'],['2028-02-29','2028-03-01'],['2026-12-31','2027-01-01']])assert.equal(relativeDate('tomorrow',today),next);
assert.equal(relativeDate('tomorrow',''),null);assert.equal(relativeDate('tomorrow','2026-02-30'),null);assert.equal(relativeDate('next Monday','2026-10-07'),null);
const chat=initial();assert.equal(chat.projectId,101);assert.match(chat.question(),/Did you mean Chloe.*Andi/);assert.equal(chat.canAcceptYes,true);assert.equal(chat.ready,false);assert.equal(chat.draft.date,'2026-10-08');
chat.consume('yes');assert.deepEqual(chat.draft.memberIds,[11,12]);assert.equal(chat.draft.startDate,'2026-10-08');assert.equal(chat.draft.endDate,'2026-10-08');assert.equal(chat.slot,'start');chat.consume('back');assert.match(chat.question(),/Did you mean/);chat.consume('no');assert.equal(chat.slot,'memberId');chat.consume('Andi');assert.equal(chat.draft.memberId,12);assert.equal(chat.draft.date,'2026-10-08');
chat.consume('cancel');assert.equal(chat.projectId,null);assert.equal(chat.canAcceptYes,false);assert.equal(chat.question(),'What do you need?');
const ambiguous=initial([...projects,{id:104,name:'Market Street Annex'}]);assert.match(ambiguous.question(),/Market Street Reno.*Market Street Annex/);assert.equal(ambiguous.canAcceptYes,false);assert.equal(ambiguous.consume('Market Street Reno').needsContext,101);ambiguous.hydrate(context);assert.equal(ambiguous.draft.date,'2026-10-08');assert.match(ambiguous.question(),/Chloe.*Andi/);
const both=initial(projects,{...context,members:twoSpellings});assert.equal(both.canAcceptYes,false);assert.match(both.question(),/Andy.*Andi|Andi.*Andy/);both.consume('yes');assert.equal(both.draft.memberIds,undefined);both.consume('Chloe and Andi');assert.deepEqual(both.draft.memberIds,[11,12]);
for(const reserved of ['yes','yeah','save','confirm','okay','ok','save it','confirm and save','do it']){const chat=initial(projects,{...context,members:[{id:11,name:'Chloe One'},{id:12,name:'Chloe Two'},{id:13,name:reserved}]},'Schedule Chloe at Market Street tomorrow from 8 AM to 4 PM. Task: Frame. Instructions: Check.');chat.consume(reserved);assert.equal(chat.ready,false);assert.equal(chat.draft.memberId,undefined,'reserved '+reserved+' cannot select an unrelated candidate');}
const complete=initial(projects,context,sentence+' from 8 AM to 4 PM. Task: Frame. Instructions: Check layout.');assert.equal(complete.ready,false);complete.consume('yes');assert.equal(complete.ready,true);assert.match(complete.consume('confirm').message,/Confirm/);complete.consume('change date');assert.equal(complete.ready,false);assert.equal(complete.consume('tomorrow').needsContext,101);assert.equal(complete.ready,false);complete.hydrate({...context,today:'2026-10-08'});assert.equal(complete.draft.startDate,'2026-10-09','relative correction refreshes the server company date across midnight');assert.equal(complete.draft.endDate,'2026-10-09');assert.deepEqual(complete.draft.memberIds,[11,12]);assert.equal(complete.draft.activity,'Frame');complete.consume('cancel');assert.equal(complete.ready,false);
const noClock=initial(projects,{...context,today:''});noClock.consume('yes');assert.equal(noClock.draft.startDate,undefined,'relative dates need the authorized server company date');
for(const text of ['Schedule Chloe at Market Street tomorrow or 2026-10-09','Schedule Chloe at Market Street not tomorrow','Schedule Chloe at Market Street day after tomorrow']){const denied=initial(projects,context,text);assert.equal(denied.draft.date,undefined);}
const literals=initial(projects,context,'Schedule Chloe at Market Street. Task: Read tomorrow report. Instructions: Ask Andy.');assert.equal(literals.draft.date,undefined);assert.equal(literals.draft.memberId,11);
assert.equal(projectsFor('Schedule ID 12 at Market Street tomorrow',[...projects,{id:12,name:'Other Site'}]).id,101,'person IDs never choose a project');
assert.equal(projectsFor('Schedule Chloe at Market Street project ID 102 tomorrow',[...projects,{id:102,name:'Other Site'}]).id,null,'conflicting project label/ID needs clarification');
const competingDate=initial(projects,context,'Schedule Chloe at Market Street on 2026-10-09 tomorrow');assert.equal(competingDate.draft.date,undefined);
for(const name of ['Tomorrow Jones','Today Jones']){const named=initial(projects,{...context,members:[{id:21,name}]},'Schedule '+name.split(' ')[0]+' at Market Street from 8 AM to 4 PM. Task: Frame. Instructions: Check.');assert.equal(named.draft.date,undefined,'partial person names cannot supply scheduling dates');}
const weekdayName=initial(projects,{...context,members:[{id:21,name:'Friday Jones'}]},'Schedule Friday at Market Street on 2026-10-07 on Friday from 8 AM to 4 PM. Task: Frame. Instructions: Check.');assert.equal(weekdayName.draft.date,undefined,'masking a person mention must retain conflicting weekday clauses');
const tomorrowName=initial(projects,{...context,members:[{id:21,name:'Tomorrow Jones'}]},'Schedule Tomorrow at Market Street tomorrow from 8 AM to 4 PM. Task: Frame. Instructions: Check.');assert.equal(tomorrowName.draft.date,'2026-10-08','masking a person mention must retain actual tomorrow date clause');
console.log('Natural-name regressions passed: scoped partial/punctuation/voice names, missing conjunction/near-name confirmation, similar projects, Andy/Andi, duplicate first names, unknown/foreign candidates, preserved original date, corrections/cancel/back, and company-date calendar arithmetic.');
