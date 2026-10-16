(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FieldDailyScope=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const QUANTITY_TOLERANCE=0.05;
  const PRODUCTIVITY_LIMIT=1.5;
  const dailyWork=typeof require==='function'?require('./daily-work-extraction'):(typeof DailyWorkExtraction!=='undefined'?DailyWorkExtraction:null);

  function normalizeUnit(raw){
    const text=String(raw||'').trim().toLowerCase().replace(/\./g,'').replace(/\s+/g,' ');
    if(!text)return '';
    if(/^(square feet|sq ft|sqft|squares?|sf)$/.test(text))return 'SF';
    if(/^(cubic yards?|yards?|yds?|yd|cy|yardas)$/.test(text))return 'CY';
    if(/^(linear feet|lineal feet|feet|ft|lf|pies)$/.test(text))return 'LF';
    if(/^(each|units?|panels?|tiles?|ea|baldosas)$/.test(text))return 'EA';
    if(/^tons?$/.test(text))return 'TON';
    if(/^(hours?|hrs?)$/.test(text))return 'HR';
    return text.toUpperCase().slice(0,10);
  }

  function tokens(text){
    const stop=new Set(['the','a','an','of','and','on','for','to','with','we','our','poured','pour','pouring','installed','installing','placed','placing','set','completed','today','crew','yards','yard','yds','feet','foot']);
    return String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(word=>word.length>2&&!stop.has(word));
  }

  function matchEstimateLine(row,items){
    const list=Array.isArray(items)?items:[];
    if(!row||!list.length)return null;
    if(dailyWork&&typeof dailyWork.scopeProposal==='function'){
      const proposal=dailyWork.scopeProposal({...row,needsScopeConfirmation:true,custom:false},list);
      if(proposal&&proposal.mode==='estimate'){
        const direct=list.find(item=>String(item.id)===String(proposal.estimateItemId));
        if(direct)return direct;
      }
    }
    const unit=normalizeUnit(row.unit);
    const words=tokens(row.description);
    const scored=list.map(item=>{
      const itemUnit=normalizeUnit(item.unit);
      const overlap=words.filter(word=>tokens(item.name).includes(word)).length;
      const unitOk=!unit||!itemUnit||unit===itemUnit;
      return {item,overlap,unitOk};
    }).filter(entry=>entry.unitOk);
    const named=scored.filter(entry=>entry.overlap>0).sort((a,b)=>b.overlap-a.overlap);
    if(named.length&&(named.length===1||named[0].overlap>named[1].overlap))return named[0].item;
    if(unit){
      const same=list.filter(item=>normalizeUnit(item.unit)===unit);
      if(same.length===1)return same[0];
    }
    const exact=list.filter(item=>String(item.name||'').trim().toLowerCase()===String(row.description||'').trim().toLowerCase());
    return exact.length===1?exact[0]:null;
  }

  function quantityOf(row){
    if(row==null||row.quantity==null||row.quantity==='')return null;
    const value=Number(row.quantity);
    return Number.isFinite(value)?Math.max(0,value):null;
  }

  const EXTRA_LANGUAGE=/\b(?:extra work|owner asked|t\s*&\s*m|t\s+and\s+m|time and materials|not in scope)\b/i;
  const MATERIAL_LANGUAGE=/^\s*(?:used|using|usage)\b/i;
  const HEADCOUNT_LANGUAGE=/^(\d+(?:\.\d+)?)\s*(?:guys?|people|persons?|workers?|men|man|crew)\b/i;
  const WORK_LANGUAGE=/\b(?:poured|pouring|placed|placing|installed|installing|formed|set|patched|patching|patch|finished|completed)\b/i;
  const QUANTITY_LANGUAGE=/\b(\d+(?:\.\d+)?)\s*(square\s+feet|sq\.?\s*ft|linear\s+feet|lineal\s+feet|cubic\s+yards?|yards?|yds?|yd|cy|feet|ft|lf|sf|ea|each|tons?)\b/i;

  function clausesOf(notes){
    return String(notes||'').replace(/^field work recorded:\s*/i,'').split(/\s*,\s*|\n+/).map(text=>text.trim()).filter(Boolean);
  }

  function sentencesOf(notes){
    return String(notes||'').replace(/^field work recorded:\s*/i,'').split(/\n+|(?<=[.!?])\s+/).map(text=>text.trim()).filter(Boolean);
  }

  function tidyFact(text){
    return String(text||'').replace(/\s+/g,' ').replace(/[.!\s]+$/,'').trim();
  }

  function isLookahead(text){
    const value=String(text||'').trim();
    if(/^(?:tomorrow|mañana|manana|next)\b/i.test(value))return true;
    return /^(?:we\s+)?need(?:s)?\b/i.test(value)&&/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|pump)\b/i.test(value);
  }

  function isDelay(text){
    if(isLookahead(text))return false;
    return /\b(?:delays?|delayed|late|waiting|held up|hold[- ]?up|rfi|breakdown|rained?|blocker|blocked)\b/i.test(String(text||''));
  }

  function isMissingMaterial(text){
    if(isLookahead(text))return false;
    return /\b(?:missing|out of|short on|ran out of|no more)\b/i.test(String(text||''));
  }

  function quantityFact(text){
    const match=String(text||'').match(QUANTITY_LANGUAGE);
    if(!match)return {quantity:null,unit:''};
    return {quantity:Number(match[1]),unit:normalizeUnit(match[2])};
  }

  function namedEstimateLine(description,unit,items){
    const words=tokens(description).filter(word=>!['concrete','extra','work','owner','asked','guys','guy','used','using','north','side','gate'].includes(word));
    const scored=(items||[]).map(item=>{
      const overlap=words.filter(word=>tokens(item.name).includes(word)).length;
      const itemUnit=normalizeUnit(item.unit);
      return {item,overlap,unitOk:!unit||!itemUnit||unit===itemUnit};
    }).filter(entry=>entry.overlap>0&&entry.unitOk).sort((a,b)=>b.overlap-a.overlap);
    if(scored.length&&(scored.length===1||scored[0].overlap>scored[1].overlap))return scored[0].item;
    if(unit&&!words.length){
      const same=(items||[]).filter(item=>normalizeUnit(item.unit)===unit);
      if(same.length===1)return same[0];
    }
    return null;
  }

  function statedCrew(notes){
    const source=String(notes||'');
    const hour='(?:hours?|hrs?)',head='(?:guys?|people|persons?|workers?|men|man)';
    const headcount=source.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${head}\\b`,'i'));
    const pair=source.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${head}\\D{0,40}(\\d+(?:\\.\\d+)?)\\s*${hour}\\b`,'i'));
    if(pair){const count=Number(pair[1]),each=Number(pair[2]);return {source:'notes',headcount:count,perPerson:each,total:Math.round(count*each*100)/100,ask:false}}
    const eachHours=source.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${hour}\\s*(?:each|apiece|per\\s+(?:person|man|worker|guy))\\b`,'i'));
    if(eachHours&&headcount){const count=Number(headcount[1]),each=Number(eachHours[1]);return {source:'notes',headcount:count,perPerson:each,total:Math.round(count*each*100)/100,ask:false}}
    const onlyHours=source.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${hour}\\b`,'i'));
    if(onlyHours)return {source:'notes',headcount:headcount?Number(headcount[1]):null,perPerson:null,total:Number(onlyHours[1]),ask:false};
    if(headcount)return {source:'ask',headcount:Number(headcount[1]),perPerson:null,total:null,ask:true};
    return {source:'ask',headcount:null,perPerson:null,total:null,ask:true};
  }

  function reviewNotes({notes,estimateItems,approvedQuantities,crewHours}={}){
    const items=Array.isArray(estimateItems)?estimateItems:[];
    const approved=approvedQuantities||{};
    const lines=[];
    const flags=[];
    const unmatchedNotes=[];
    const materials=[];
    const nextParts=[];
    const delayParts=[];
    const seen=new Set();
    const workClauses=[];
    for(const sentence of sentencesOf(notes)){
      if(isLookahead(sentence)){nextParts.push(tidyFact(sentence));continue}
      if(isDelay(sentence)&&!WORK_LANGUAGE.test(sentence)&&!EXTRA_LANGUAGE.test(sentence)){delayParts.push(tidyFact(sentence));continue}
      if(isMissingMaterial(sentence)&&!WORK_LANGUAGE.test(sentence)&&!EXTRA_LANGUAGE.test(sentence)){materials.push(tidyFact(sentence));continue}
      for(const clause of clausesOf(sentence)){
        if(isLookahead(clause)){nextParts.push(tidyFact(clause));continue}
        if(isDelay(clause)&&!WORK_LANGUAGE.test(clause)&&!EXTRA_LANGUAGE.test(clause)){delayParts.push(tidyFact(clause));continue}
        if(isMissingMaterial(clause)&&!WORK_LANGUAGE.test(clause)&&!EXTRA_LANGUAGE.test(clause)){materials.push(tidyFact(clause));continue}
        workClauses.push(clause);
      }
    }
    for(const clause of workClauses){
      if(HEADCOUNT_LANGUAGE.test(clause)&&!QUANTITY_LANGUAGE.test(clause)&&!WORK_LANGUAGE.test(clause))continue;
      if(EXTRA_LANGUAGE.test(clause)){
        const description=clause.replace(/^\s*extra work:\s*/i,'').trim().slice(0,300);
        flags.push({kind:'extra',reason:'stated_extra',description,quantity:quantityFact(clause).quantity,unit:quantityFact(clause).unit,estimateItemId:null,createsChange:false,decision:null,extra_work:false,who_asked:whoAsked(clause)||whoAsked(notes),message:'The notes call this extra work. Confirm it is extra, or mark it as normal scope. The office decides whether it is billable.'});
        continue;
      }
      if(MATERIAL_LANGUAGE.test(clause)){materials.push(clause.replace(/^\s*(?:used|using|usage)\s+/i,'').trim());continue}
      if(!WORK_LANGUAGE.test(clause)&&!QUANTITY_LANGUAGE.test(clause))continue;
      const fact=quantityFact(clause);
      const match=namedEstimateLine(clause,fact.unit,items);
      if(!match){
        unmatchedNotes.push(clause);
        flags.push({kind:'pick',reason:'no_match',description:clause.slice(0,300),quantity:fact.quantity,unit:fact.unit,estimateItemId:null,createsChange:false,decision:null,message:'No estimate line matches. Pick the line, or mark it extra work.'});
        continue;
      }
      const key=`${match.id}|${fact.quantity}|${normalizeUnit(match.unit)}`;
      if(seen.has(key))continue;
      seen.add(key);
      const unit=normalizeUnit(match.unit)||fact.unit;
      const quantity=fact.quantity;
      const line={description:String(match.name||'').slice(0,160),estimateItemId:match.id,quantity,unit,laborHours:0,aiFilled:true};
      lines.push(line);
      const planned=Number(match.plannedQuantity),already=Number(approved[match.id]??approved[String(match.id)]??0)||0;
      if(quantity!=null&&planned>0&&already+quantity>planned*(1+QUANTITY_TOLERANCE)){
        flags.push({kind:'extra',reason:'over_quantity',description:line.description,quantity,unit,estimateItemId:match.id,plannedQuantity:planned,approvedQuantity:already,createsChange:false,decision:null,message:`Approved ${already} plus today ${quantity} ${unit} is over the ${planned} ${unit} estimate.`});
      }
    }
    const crew=statedCrew(notes);
    const hours=Math.max(0,Number(crew.total)||Number(crewHours)||0);
    const comparable=lines.filter(line=>{
      const item=items.find(entry=>String(entry.id)===String(line.estimateItemId));
      return item&&Number(item.budgetHours)>0&&Number(item.plannedQuantity)>0&&line.quantity>0;
    });
    if(hours>0&&comparable.length===1){
      const line=comparable[0],item=items.find(entry=>String(entry.id)===String(line.estimateItemId));
      const expected=Number(item.budgetHours)/Number(item.plannedQuantity)*line.quantity;
      if(expected>0&&hours>expected*PRODUCTIVITY_LIMIT){
        flags.push({kind:'productivity',reason:'hours_over_budget',description:line.description,quantity:line.quantity,unit:line.unit,estimateItemId:line.estimateItemId,laborHours:Math.round(hours*100)/100,expectedHours:Math.round(expected*100)/100,createsChange:false,decision:null,message:`${Math.round(hours*100)/100} hours is far over the estimate rate of about ${Math.round(expected*100)/100} hours. This is a productivity flag, not a change order.`});
      }
    }
    return {lines,flags,unmatchedNotes,materials:[...new Set(materials.filter(Boolean))].join('; '),hours:crew,next:[...new Set(nextParts.filter(Boolean))].join('. '),delays:[...new Set(delayParts.filter(Boolean))].join(' ')};
  }

  function namedCrewGaps(notes,crew,punchedMemberIds){
    const list=punchedMemberIds instanceof Set?[...punchedMemberIds]:Array.isArray(punchedMemberIds)?punchedMemberIds:[];
    const punched=new Set(list.map(Number));
    const people=(crew||[]).filter(person=>person&&!punched.has(Number(person.id)));
    const source=String(notes||'');
    const named=people.filter(person=>{
      const first=String(person?.name||'').trim().split(/\s+/)[0]||'';
      if(first.length<3)return false;
      const token=first.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp(`\\b${token}\\b`,'i').test(source);
    });
    const count=Number(statedCrew(notes).headcount)||0;
    if(!(count>0))return named;
    const punchedOnCrew=(crew||[]).filter(person=>punched.has(Number(person.id))).length;
    const needed=Math.max(count-punchedOnCrew,named.length);
    const gaps=named.slice();
    for(const person of people){
      if(gaps.length>=needed)break;
      if(!gaps.some(row=>Number(row.id)===Number(person.id)))gaps.push(person);
    }
    return gaps;
  }

  function noPunchLabel(){return 'No punch, enter hours'}

  function crewGapReason(people){
    const names=(people||[]).map(person=>String(person.name||'').trim().split(/\s+/)[0]).filter(Boolean);
    if(!names.length)return '';
    const list=names.length===1?names[0]:names.length===2?`${names[0]} and ${names[1]}`:`${names.slice(0,-1).join(', ')}, and ${names.at(-1)}`;
    return `${list} ${names.length===1?'has':'have'} no clock-in. Enter their hours.`;
  }

  function round2(value){return Math.round((Number(value)||0)*100)/100}

  function elapsedMinutes(start,end){
    const ms=new Date(end)-new Date(start);
    if(!Number.isFinite(ms)||ms<=0)return 0;
    return Math.round(ms/60000);
  }

  function formatMinutes(minutes){
    const value=Math.max(0,Math.round(Number(minutes)||0));
    if(!Number.isFinite(value))return '';
    if(value<60)return `${value} min`;
    return `${(value/60).toFixed(2)} h`;
  }

  function formatHours(hours){return formatMinutes(Math.round((Number(hours)||0)*60))}

  function hoursFromMinutes(minutes){return round2(Math.max(0,Number(minutes)||0)/60)}

  function punchLengthLabel(card){
    if(!card?.outAt||!card?.inAt)return '';
    return formatMinutes(elapsedMinutes(card.inAt,card.outAt));
  }

  function laborTotal({punches,entered}={}){
    const byId=new Map();
    for(const punch of punches||[]){
      const id=Number(punch?.memberId);
      if(!Number.isFinite(id))continue;
      const hours=punch?.minutes!=null?hoursFromMinutes(punch.minutes):round2(punch?.hours);
      if(!(hours>0))continue;
      const prev=byId.get(id)||{memberId:id,hours:0,source:'punch'};
      prev.hours=round2(prev.hours+hours);
      prev.source='punch';
      byId.set(id,prev);
    }
    for(const row of entered||[]){
      const id=Number(row?.memberId);
      if(!Number.isFinite(id)||byId.has(id))continue;
      const hours=round2(row?.hours);
      if(!(hours>0))continue;
      byId.set(id,{memberId:id,hours,source:'entered'});
    }
    const entries=[...byId.values()];
    return {entries,total:round2(entries.reduce((sum,row)=>sum+row.hours,0))};
  }

  function dedupeLaborEntries(entries){
    const map=new Map();
    for(const row of entries||[]){
      const id=Number(row?.memberId);
      if(!Number.isFinite(id)||map.has(id))continue;
      map.set(id,{...row,memberId:id,hours:round2(row.hours)});
    }
    return [...map.values()].filter(row=>Number(row.hours)>0);
  }

  function rawNoteLine(entry,notes){
    const matched=entry?.estimateItemId!=null&&String(entry.estimateItemId)!==''&&Number(entry.quantity)>0;
    if(matched)return false;
    const desc=String(entry?.description||'').trim();
    const note=String(notes||'').trim().toLowerCase();
    if(!desc||!note)return false;
    const text=desc.toLowerCase();
    if(text===note)return true;
    return text.length>=24&&note.includes(text);
  }

  function dedupeProductionLines(lines){
    const kept=[],seen=new Map();
    for(const line of lines||[]){
      if(!line)continue;
      const key=line.estimateItemId!=null&&line.estimateItemId!==''?`id:${line.estimateItemId}`:`desc:${String(line.description||'').trim().toLowerCase()}`;
      if(seen.has(key)){
        const at=seen.get(key);
        if(Number(line.quantity)>Number(kept[at].quantity))kept[at]={...kept[at],...line};
        continue;
      }
      seen.set(key,kept.length);
      kept.push({...line});
    }
    return kept;
  }

  function keepProductionLines(entries,notes){
    const kept=(entries||[]).filter(entry=>entry&&String(entry.description||'').trim()&&!rawNoteLine(entry,notes));
    return dedupeProductionLines(kept);
  }

  function normalizeLaborGaps(rows){
    return (Array.isArray(rows)?rows:[]).filter(row=>row&&(row.memberId!=null||row.name)).slice(0,20).map(row=>({memberId:Number(row.memberId)||null,name:String(row.name||'').trim().slice(0,80)}));
  }

  function mergeScopeFlags(previous,incoming){
    const prior=Array.isArray(previous)?previous:[];
    return (Array.isArray(incoming)?incoming:[]).map(flag=>{
      const exact=prior.find(row=>row&&row.reason===flag.reason&&String(row.description||'')===String(flag.description||''));
      const stated=prior.filter(row=>row&&row.reason==='stated_extra'&&flag?.reason==='stated_extra');
      const match=exact||(stated.length===1?stated[0]:null);
      if(!match||!match.decision)return {...flag,decision:null,createsChange:false,who_asked:String(match?.who_asked||flag?.who_asked||'')};
      return {...flag,decision:match.decision,createsChange:false,extra_work:match.decision==='extra',who_asked:String(match.who_asked||flag.who_asked||'')};
    });
  }

  function splitCents(cents,weights){
    const count=weights.length;
    if(!count)return [];
    const target=Math.max(0,Math.round(Number(cents)||0));
    if(!target)return weights.map(()=>0);
    const sum=weights.reduce((total,weight)=>total+(Number(weight)||0),0);
    const raw=weights.map(weight=>sum>0?target*(Number(weight)||0)/sum:target/count);
    const floors=raw.map(value=>Math.floor(value+1e-9));
    let left=target-floors.reduce((total,value)=>total+value,0);
    const order=raw.map((value,index)=>({index,value,weight:Number(weights[index])||0})).sort((a,b)=>b.weight-a.weight||b.value-a.value||a.index-b.index);
    let cursor=0;
    while(left>0&&order.length){floors[order[cursor%order.length].index]+=1;left-=1;cursor+=1}
    return floors;
  }

  function allocateLaborHours({total,lines}={}){
    const rows=(Array.isArray(lines)?lines:[]).map(line=>({...line,manual:line?.manual===true,hours:Math.max(0,round2(line?.hours))}));
    const crew=Math.max(0,round2(total));
    const manual=rows.filter(line=>line.manual);
    const auto=rows.filter(line=>!line.manual);
    const manualSum=round2(manual.reduce((sum,line)=>sum+line.hours,0));
    if(manualSum-crew>0.001){
      for(const line of auto)line.hours=0;
      return {lines:rows,total:crew,allocated:round2(rows.reduce((sum,line)=>sum+line.hours,0)),warning:'Manual hours are over the labor total. Auto lines stay at 0.'};
    }
    const remaining=round2(Math.max(0,crew-manualSum));
    const rated=auto.every(line=>Number(line.quantity)>0&&Number(line.unitRate)>0);
    const weights=auto.map(line=>rated?Number(line.quantity)*Number(line.unitRate):1);
    const cents=splitCents(Math.round(remaining*100),weights);
    auto.forEach((line,index)=>{line.hours=cents[index]/100});
    return {lines:rows,total:crew,allocated:round2(rows.reduce((sum,line)=>sum+line.hours,0)),warning:''};
  }

  function sameDayDaily(reports,{projectIndex,dateIso,memberIds,foreman}={}){
    const members=new Set((memberIds||[]).map(Number));
    const name=String(foreman||'').trim().toLowerCase();
    const rows=(reports||[]).filter(report=>report&&!report.deletedAt&&Number(report.project)===Number(projectIndex)&&String(report.dateIso||'')===String(dateIso||''));
    const mine=rows.filter(report=>name&&String(report.foreman||'').trim().toLowerCase()===name||(report.laborEntries||[]).some(row=>members.has(Number(row.memberId))));
    const rank=report=>String(report.status||'')==='Draft'?0:1;
    return mine.slice().sort((a,b)=>rank(b)-rank(a)||Number(b.id)-Number(a.id))[0]||null;
  }

  function clientProjectIndex(projects,report){
    const list=Array.isArray(projects)?projects:[];
    const byId=list.findIndex(project=>report?.projectId!=null&&Number(project.id)===Number(report.projectId));
    if(byId>=0)return byId;
    const index=Number(report?.project);
    return list[index]?index:-1;
  }

  function sendGate({flags,laborHours,openClock,lines}={}){
    const block=[],warn=[];
    if((flags||[]).some(flag=>flag&&!flag.decision))block.push('Answer each flag before sending this daily to the office.');
    if(!(Number(laborHours)>0))block.push('Enter the crew hours before sending.');
    if((lines||[]).some(line=>line&&line.needsQuantity&&!(Number(line.quantity)>0)))block.push('Enter a quantity for each work line.');
    if(openClock)warn.push('The crew is still clocked in. Clock out before you send so the hours match the punch.');
    return {block,warn};
  }

  function clockOutMessage(notes){
    return String(notes||'').trim()?'':'Add what was completed before clocking out.';
  }

  function reviewScope({productions,estimateItems,approvedQuantities,crewHours,notes}={}){
    if(String(notes||'').trim())return reviewNotes({notes,estimateItems,approvedQuantities,crewHours});
    const items=Array.isArray(estimateItems)?estimateItems:[];
    const approved=approvedQuantities||{};
    const lines=[];
    const flags=[];
    const unmatchedNotes=[];
    const rows=(Array.isArray(productions)?productions:[]).filter(row=>row&&String(row.description||'').trim());
    for(const row of rows){
      const match=matchEstimateLine(row,items);
      const quantity=quantityOf(row);
      if(!match){
        unmatchedNotes.push(String(row.description).trim());
        flags.push({kind:'extra',reason:'no_match',description:String(row.description).trim().slice(0,300),quantity,unit:normalizeUnit(row.unit),estimateItemId:null,createsChange:false,decision:null,message:'No estimate line matches. This stays in the notes until you answer.'});
        continue;
      }
      const unit=normalizeUnit(match.unit)||normalizeUnit(row.unit);
      const planned=Number(match.plannedQuantity);
      const already=Number(approved[match.id]??approved[String(match.id)]??0)||0;
      const line={description:String(match.name||'').slice(0,160),estimateItemId:match.id,quantity,unit,laborHours:Math.max(0,Number(row.laborHours)||0),aiFilled:true};
      lines.push(line);
      if(quantity!=null&&planned>0&&already+quantity>planned*(1+QUANTITY_TOLERANCE)){
        flags.push({kind:'extra',reason:'over_quantity',description:line.description,quantity,unit,estimateItemId:match.id,plannedQuantity:planned,approvedQuantity:already,createsChange:false,decision:null,message:`Approved ${already} plus today ${quantity} ${unit} is over the ${planned} ${unit} estimate.`});
      }
    }
    const hours=Math.max(0,Number(crewHours)||0);
    const comparable=lines.filter(line=>{
      const item=items.find(entry=>String(entry.id)===String(line.estimateItemId));
      return item&&Number(item.budgetHours)>0&&Number(item.plannedQuantity)>0&&line.quantity>0;
    });
    if(hours>0&&comparable.length===1){
      const line=comparable[0],item=items.find(entry=>String(entry.id)===String(line.estimateItemId));
      const expected=Number(item.budgetHours)/Number(item.plannedQuantity)*line.quantity;
      if(expected>0&&hours>expected*PRODUCTIVITY_LIMIT){
        flags.push({kind:'productivity',reason:'hours_over_budget',description:line.description,quantity:line.quantity,unit:line.unit,estimateItemId:line.estimateItemId,laborHours:Math.round(hours*100)/100,expectedHours:Math.round(expected*100)/100,createsChange:false,decision:null,message:`${Math.round(hours*100)/100} hours is far over the estimate rate of about ${Math.round(expected*100)/100} hours. This is a productivity flag, not a change order.`});
      }
    }
    return {lines,flags,unmatchedNotes,materials:'',hours:statedCrew(''),next:'',delays:''};
  }

  function whoAsked(text){
    const match=String(text||'').match(/\b(?:the\s+|our\s+)?([A-Za-z][A-Za-z'’.-]{1,40}(?:\s+[A-Za-z][A-Za-z'’.-]{1,40}){0,2})\s+asked\b/i);
    return match?match[1].replace(/^(?:the|our|a|an)\s+/i,'').trim().slice(0,80):'';
  }

  function decideFlag(flag,choice){
    if(!flag)return null;
    if(flag.kind==='productivity')return {...flag,decision:'noted',createsChange:false,extra_work:false};
    if(choice==='yes'||choice==='extra'||choice==='bill')return {...flag,decision:'extra',createsChange:false,extra_work:true};
    if(choice==='no'||choice==='not')return {...flag,decision:'not',createsChange:false,extra_work:false};
    return {...flag,decision:'estimate',createsChange:false,extra_work:false,estimateItemId:flag.estimateItemId??null};
  }

  function fieldExtraItems(flags){
    return (Array.isArray(flags)?flags:[]).filter(flag=>flag&&flag.kind!=='productivity'&&flag.decision==='extra').map(flag=>{
      const item={description:String(flag.description||'Extra work').slice(0,300),extra_work:true,who_asked:String(flag.who_asked||flag.whoAsked||'').trim().slice(0,80)};
      if(flag.quantity!=null&&flag.quantity!=='')item.quantity=Number(flag.quantity)||0;
      if(flag.unit)item.unit=String(flag.unit).slice(0,20);
      return item;
    });
  }

  function confirmedExtraChanges(flags){
    return (Array.isArray(flags)?flags:[]).filter(flag=>flag&&flag.kind!=='productivity'&&flag.decision==='extra'&&flag.createsChange===true).map(flag=>({title:String(flag.description||'Extra work').slice(0,160),detail:flag.reason==='over_quantity'?'Quantity is over the estimate. The field confirmed it as extra work.':flag.reason==='stated_extra'?'The notes call this extra work. The field confirmed it should be billed.':'No estimate line matches. The field confirmed it as extra work.',quantity:flag.quantity==null?null:Number(flag.quantity)||0,unit:String(flag.unit||'').slice(0,20),status:'Potential'}));
  }

  function approvedQuantityMap(reports,projectIndex){
    const totals={};
    for(const report of reports||[]){
      if(report?.status!=='Approved'||Number(report.project)!==Number(projectIndex))continue;
      for(const entry of report.productionEntries||[]){
        if(entry?.estimateItemId==null)continue;
        const id=String(entry.estimateItemId);
        totals[id]=(totals[id]||0)+(Number(entry.quantity)||0);
      }
    }
    return totals;
  }

  function hoursFromClock({cards,projectId,date,scheduled}={}){
    const used=(Array.isArray(cards)?cards:[]).filter(card=>card&&!card.deletedAt&&Number(card.projectId)===Number(projectId)&&String(card.date||'')===String(date||'')&&card.inAt&&card.outAt&&Number(card.hours)>0);
    const totals=new Map();
    for(const card of used)totals.set(Number(card.memberId),(totals.get(Number(card.memberId))||0)+Number(card.hours));
    return {source:totals.size?'clock':'none',laborEntries:[...totals].map(([memberId,hours])=>({memberId,hours:Math.round(hours*100)/100,source:'clock'})),scheduledIgnored:Array.isArray(scheduled)&&scheduled.length>0};
  }

  function submissionStatus(requested){
    return String(requested||'')==='Draft'?'Draft':'Needs review';
  }

  function singleLineLaborHours(rows,crewHours){
    const produced=(Array.isArray(rows)?rows:[]).filter(row=>Number(row?.quantity)>0);
    const crew=Number(crewHours)||0;
    if(produced.length!==1||!(crew>0)||Number(produced[0].laborHours)>0)return null;
    return Math.round(crew*100)/100;
  }

  return {normalizeUnit,matchEstimateLine,reviewScope,reviewNotes,decideFlag,confirmedExtraChanges,fieldExtraItems,whoAsked,approvedQuantityMap,hoursFromClock,statedCrew,sendGate,clockOutMessage,submissionStatus,namedCrewGaps,crewGapReason,noPunchLabel,punchLengthLabel,formatMinutes,formatHours,hoursFromMinutes,elapsedMinutes,laborTotal,dedupeLaborEntries,rawNoteLine,dedupeProductionLines,keepProductionLines,normalizeLaborGaps,mergeScopeFlags,allocateLaborHours,sameDayDaily,clientProjectIndex,singleLineLaborHours,QUANTITY_TOLERANCE,PRODUCTIVITY_LIMIT};
});
