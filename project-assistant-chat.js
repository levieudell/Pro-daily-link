(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./project-assistant-conversation'):root.PDLAssistantConversation);if(typeof module==='object'&&module.exports)module.exports=api;else root.PDLAssistantChat=api;})(typeof globalThis!=='undefined'?globalThis:this,function(voice){
  'use strict';
  const clean=value=>String(value||'').trim().toLowerCase().replace(/[.!?]+$/,'');
  const quote=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const shiftExpression=/\bfrom\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{2}:\d{2})\s+(?:to|until)\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{2}:\d{2})\b/i;
  function scheduleHeader(text){const raw=String(text).split(/\b(?:task|instructions)\s*:/i)[0],shift=raw.match(shiftExpression),end=shift?shift.index+shift[0].length:0;return shift&&/^\s+to\s+[a-z]/i.test(raw.slice(end))?raw.slice(0,end):raw;}
  function intent(text){const value=clean(text);if(/^(?:please\s+)?(?:schedule|assign|book)\b/.test(value))return 'schedule';if(/^(?:please\s+)?(?:(?:add|create|make)\s+(?:a\s+)?)?(?:to-do|todo)\b/.test(value))return 'todo';if(/^(?:please\s+)?(?:(?:add|create|make|leave|record)\s+(?:a\s+)?(?:project\s+)?)?note\b/.test(value))return 'note';return null;}
  function projectFor(text,projects,answer=false){
    if(!answer)text=intent(text)==='schedule'?scheduleHeader(text):String(text).split(/:\s|\b(?:note|to-do|todo)\s+that\b/i)[0];
    const value=clean(text),id=value.match(/^(?:project\s+)?id\s+(\d+)$/);
    if(!answer&&/\b(?:not|except|instead of|don't use|do not use)\b/i.test(text))return null;
    const matches=projects.filter(row=>id?Number(row.id)===Number(id[1]):answer?clean(row.name)===value:new RegExp('\\b(?:at|for|on|in|project)\\s+(?:project\\s+)?'+quote(row.name)+'(?=$|[\\s.,:;!?])','i').test(text));
    const explicitIds=[...String(text).matchAll(/\bproject\s+id\s+(\d+)\b/gi)].map(match=>Number(match[1]));
    if(explicitIds.some(id=>!projects.some(row=>Number(row.id)===id)))return null;
    if(!answer){const mentions=projects.filter(row=>new RegExp('(?:^|\\b)'+quote(row.name)+'(?=$|[\\s.,:;!?])','i').test(text));if(mentions.length>1||mentions.some(row=>new RegExp(quote(row.name)+'\\s+(?:or|and)\\b','i').test(text)))return null;}
    const combined=[...new Map([...matches,...projects.filter(row=>explicitIds.includes(Number(row.id)))].map(row=>[Number(row.id),row])).values()];
    return combined.length===1?Number(combined[0].id):null;
  }
  function datesIn(text){return [...String(text).matchAll(/\b(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/gi)].map(match=>voice.exactDate(match[0])).filter(Boolean);}
  function proposedFields(text,draft,context){
    const next={...draft},value=String(text),members=context?.members||[];
    if(['note','todo'].includes(next.action)){
      // A colon or explicit "note that" separates command/context from literal text.
      let body=value.match(/:\s*([\s\S]+)$/)?.[1]||value.match(/\b(?:note|to-do|todo)\s+that\s+([\s\S]+)$/i)?.[1];
      if(body){
        if(next.action==='todo'){
          const due=body.match(/[.;]\s*due\s+(today|\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})[.!]?$/i);
          if(due&&!/\b(?:not|never|except)\s*$/i.test(body.slice(0,due.index))){const date=voice.exactDate(due[1]);next.deadline=clean(due[1])==='today'?'today':'date';if(date)next.dueDate=date;body=body.slice(0,due.index).trim();}
        }else next.deadline='none';
        if(body.trim())next.text=body.trim();
      }
      return next;
    }
    const header=scheduleHeader(value),ambiguous=/\b(?:or|not|except|excluding|instead of)\b/i.test(header);
    // Names are data, never date/weekday/time clauses. Extract only explicit
    // scheduling clauses after removing the exact authorized entity names.
    let clauses=header;for(const name of [context?.project?.name,...members.map(row=>row.name)].filter(Boolean))clauses=clauses.replace(new RegExp(quote(name),'gi'),match=>'X'.repeat(match.length));
    const datePattern='(?:\\d{4}-\\d{2}-\\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})';
    const dateClauses=[...clauses.matchAll(new RegExp('\\b(?:on|across|between)\\s+('+datePattern+'(?:\\s+(?:through|until|and|to)\\s+'+datePattern+')?)','gi'))];
    const who=header.match(/^(?:please\s+)?(?:schedule|assign|book)\s+(.+?)(?=\s+(?:at|on|for|in|from|across|between)\b|[.;]|$)/i)?.[1];
    const ids=who&&!ambiguous?voice.people(who,members,true):null;
    const dates=ambiguous||dateClauses.length!==1?[]:datesIn(dateClauses[0][1]),range=/\b(?:across|through|until|between)\b/i.test(clauses);
    const days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'],dayPattern='(?:'+days.join('|')+')';
    const weekdayClause=clauses.match(new RegExp('\\bon\\s+('+dayPattern+'[\\s\\S]*?)(?=\\s+from\\b|[.;]|$)','i'))?.[1]?.trim();
    const named=weekdayClause&&new RegExp('^'+dayPattern+'(?:\\s*(?:,|and)\\s*'+dayPattern+')*$','i').test(weekdayClause)?days.map((day,index)=>new RegExp('\\b'+day+'\\b','i').test(weekdayClause)?index:null).filter(day=>day!=null):[];
    if(ids?.length>1||range)next.action='schedule_batch';
    if(ids){if(next.action==='schedule_batch')next.memberIds=ids;else next.memberId=ids[0];}
    if(next.action==='schedule_batch'){
      if(dates.length===2&&range){next.startDate=dates[0];next.endDate=dates[1];}
      else if(dates.length===1){next.startDate=dates[0];if(!range){next.endDate=dates[0];next.weekdays=[new Date(dates[0]+'T12:00:00Z').getUTCDay()];}}
      if(range&&!ambiguous&&named.length)next.weekdays=named;
    }else if(dates.length===1){if(!weekdayClause||named.length===1&&named[0]===new Date(dates[0]+'T12:00:00Z').getUTCDay())next.date=dates[0];}
    const shift=clauses.match(shiftExpression);
    const explicitTimes=[...clauses.matchAll(/\b(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{2}:\d{2})\b/gi)];
    if(shift&&explicitTimes.length===2&&!ambiguous){const start=voice.exactTime(shift[1]),end=voice.exactTime(shift[2]);if(start&&end){next.start=start;next.end=end;}}
    const instructions=value.match(/\binstructions\s*:\s*([\s\S]+)$/i)?.[1];
    const task=value.match(/\btask\s*:\s*([\s\S]+?)(?=\s+instructions\s*:|$)/i)?.[1]|| (shift?value.slice(shift.index+shift[0].length).match(/^\s+to\s+([\s\S]+?)(?=[.;]\s*instructions\s*:|$)/i)?.[1]:null);
    if(task?.trim())next.activity=task.trim().replace(/[.;]+$/,'');if(instructions?.trim())next.instructions=instructions.trim();
    return next;
  }
  function createChat({projects=[]}={}){
    projects=projects.filter(row=>!row.archived&&!['Completed','Cancelled'].includes(row.status));
    let draft={},projectId=null,context=null,original='',history=[],problem='';
    const snapshot=()=>({draft:JSON.parse(JSON.stringify(draft)),projectId,context,original,problem});
    const slot=()=>!draft.action?'action':!projectId?'project':voice.missingSlot(draft);
    function question(){
      if(['schedule','schedule_batch'].includes(draft.action)&&context?.capabilities?.schedule===false)return 'Scheduling is unavailable for your access. Would you like to add a note or to-do?';
      if(problem)return problem;
      const key=slot();if(!original&&!draft.action)return 'What do you need?';
      if(key==='action')return 'I can help with a schedule, project note or to-do. Which did you mean?';
      if(key==='project')return 'Which project is this for? Say its exact name or project ID.';
      const questions={memberId:'Who should I schedule? Use their full name, or ID if names repeat.',memberIds:'Which people should I schedule? Use full names separated by and, or IDs.',date:'What exact date, including the year?',startDate:'What exact start date, including the year?',endDate:'What exact end date, including the year?',weekdays:'Which days of the week should they work? Name each intended day.',start:`What start time in ${context?.timezone||'the company timezone'}? Include AM or PM.`,end:`What end time in ${context?.timezone||'the company timezone'}? Include AM or PM.`,activity:'What task should they work on?',instructions:'What daily instructions should they receive?',text:'What exact text should I add?',deadline:'When is this to-do due? Say no deadline, today, or an exact date.',dueDate:'What exact due date, including the year?'};
      return key?questions[key]:'Everything is ready for preview. Nothing has been saved.';
    }
    function hydrate(value){context=value;problem='';draft=proposedFields(original,draft,context);draft.timezone=value.timezone||'';if(['schedule','schedule_batch'].includes(draft.action)&&value.capabilities?.schedule===false)problem='Scheduling is unavailable for your access. Would you like to add a note or to-do?';}
    function consume(text){
      const value=String(text||'').trim();if(!value||value.length>6000)return {message:'Please send one request using 6,000 characters or fewer.'};
      if(['cancel','cancel request','cancel conversation','stop conversation'].includes(clean(value))){reset();return {cancelled:true};}
      if(['back','go back'].includes(clean(value))){const last=history.pop();if(last){({draft,projectId,context,original,problem}=last);}else reset();return {back:true,needsContext:projectId&&!context?projectId:null};}
      history.push(snapshot());if(history.length>40)history.shift();problem='';
      if(['yes','save','confirm','do it','okay','ok'].includes(clean(value)))return {message:'Use Confirm and save only after reviewing the exact preview.'};
      if(clean(value)==='preview these changes')return {};
      const change=clean(value).match(/^(?:change|edit) (project|person|people|date|start date|end date|start time|end time|task|daily instructions|text|deadline|due date|weekdays)$/);
      if(change){const keys={project:'project',person:'memberId',people:'memberIds',date:'date','start date':'startDate','end date':'endDate','start time':'start','end time':'end',task:'activity','daily instructions':'instructions',text:'text',deadline:'deadline','due date':'dueDate',weekdays:'weekdays'},key=keys[change[1]];
        if(key==='project'){projectId=null;context=null;draft={action:draft.action};original='';}else{draft[key]=['memberIds','weekdays'].includes(key)?[]:'';if(key==='deadline')draft.dueDate='';}return {};
      }
      if(!draft.action){
        const action=intent(value)||(['schedule','schedule_batch','note','todo','to-do'].includes(clean(value))?clean(value).replace('to-do','todo'):null);
        if(!original)original=value;
        if(!action)return {message:question()};draft.action=action;if(action==='note')draft.deadline='none';
        projectId=projectFor(original,projects);if(!projectId)return {};
        return {needsContext:projectId};
      }
      if(!projectId){const selected=projectFor(value,projects,true);if(!selected)return {message:'I could not identify one project safely. What is its exact name or project ID?'};projectId=selected;return {needsContext:projectId};}
      if(!context)return {needsContext:projectId};
      if(['schedule','schedule_batch'].includes(draft.action)&&context.capabilities?.schedule===false){const action=intent(value);if(!['note','todo'].includes(action))return {message:'Scheduling is unavailable for your access. Would you like to add a note or to-do?'};draft={action};original=value;hydrate(context);return {};}
      const key=slot();
      if(!key)return {message:'Say preview these changes for a fresh preview, or change and a field name. Saving uses the Confirm button.'};
      if(key==='deadline'){const date=voice.exactDate(value);if(date){draft.deadline='date';draft.dueDate=date;return {};}}
      const answer=voice.parseAnswer(key,value,context);if(answer==null)return {message:`I could not use that answer safely. ${question()}`};draft[key]=answer;return {};
    }
    function reset(){draft={};projectId=null;context=null;original='';history=[];problem='';}
    function adopt(value,id,ctx){draft={...value};projectId=id;context=ctx;problem='';original='';}
    return {consume,hydrate,reset,adopt,question,get slot(){return slot();},get draft(){return {...draft};},get projectId(){return projectId;},get context(){return context;},get ready(){return Boolean(projectId&&context&&!problem&&!slot()&&(!['schedule','schedule_batch'].includes(draft.action)||context.capabilities?.schedule!==false));}};
  }
  function previewText(result){const row=result.proposal;
    const project=row.projectName+(Number.isSafeInteger(row.projectId)?` (project ID ${row.projectId})`:'');
    if(row.action==='note'||row.action==='todo')return `${row.action==='note'?'Add a note':'Add an open, unassigned to-do'} to ${project}: ${row.text}${row.action==='todo'?` Due${row.deadline==='today'?' today':''}: ${row.dueDate?row.dueDate+' ('+row.timezone+')':'no deadline'}.`:''} Visible to the authorized project team. No notifications or public sharing.`;
    const people=row.action==='schedule_batch'?row.members.map(member=>`${member.name} (ID ${member.id})`).join(', '):`${row.memberName} (ID ${row.memberId})`;
    return `Schedule ${people} at ${project}, ${row.action==='schedule_batch'?'on every listed date: '+row.dates.join(', '):row.date}, ${row.start}-${row.end} (${row.timezone}). Task: ${row.activity}. Daily instructions: ${row.instructions}. ${row.notification}${row.action==='schedule_batch'?` ${row.dates.length} daily assignment records for ${row.members.length} people (${row.personDays} person/day combinations). The entire batch saves together or none does.`:''}`;
  }
  return {intent,projectFor,datesIn,proposedFields,createChat,previewText};
});
