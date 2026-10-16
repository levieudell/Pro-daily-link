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
    const seen=new Set();
    for(const clause of clausesOf(notes)){
      if(HEADCOUNT_LANGUAGE.test(clause)&&!QUANTITY_LANGUAGE.test(clause)&&!WORK_LANGUAGE.test(clause))continue;
      if(EXTRA_LANGUAGE.test(clause)){
        const description=clause.replace(/^\s*extra work:\s*/i,'').trim().slice(0,300);
        flags.push({kind:'extra',reason:'stated_extra',description,quantity:quantityFact(clause).quantity,unit:quantityFact(clause).unit,estimateItemId:null,createsChange:false,decision:null,message:'The notes call this extra work. Bill it, or mark it as not extra.'});
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
    return {lines,flags,unmatchedNotes,materials:[...new Set(materials)].join('; '),hours:crew};
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
    return {lines,flags,unmatchedNotes,materials:'',hours:statedCrew('')};
  }

  function decideFlag(flag,choice){
    if(!flag)return null;
    if(flag.kind==='productivity')return {...flag,decision:'noted',createsChange:false};
    if(choice==='extra'||choice==='bill')return {...flag,decision:'extra',createsChange:true};
    if(choice==='not')return {...flag,decision:'not',createsChange:false};
    return {...flag,decision:'estimate',createsChange:false,estimateItemId:flag.estimateItemId??null};
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

  return {normalizeUnit,matchEstimateLine,reviewScope,reviewNotes,decideFlag,confirmedExtraChanges,approvedQuantityMap,hoursFromClock,statedCrew,sendGate,clockOutMessage,submissionStatus,QUANTITY_TOLERANCE,PRODUCTIVITY_LIMIT};
});
