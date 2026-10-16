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

  function reviewScope({productions,estimateItems,approvedQuantities,crewHours}={}){
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
    return {lines,flags,unmatchedNotes};
  }

  function decideFlag(flag,choice){
    if(!flag)return null;
    if(flag.kind==='productivity')return {...flag,decision:'noted',createsChange:false};
    if(choice==='extra')return {...flag,decision:'extra',createsChange:true};
    return {...flag,decision:'estimate',createsChange:false};
  }

  function confirmedExtraChanges(flags){
    return (Array.isArray(flags)?flags:[]).filter(flag=>flag&&flag.kind==='extra'&&flag.decision==='extra'&&flag.createsChange===true).map(flag=>({title:String(flag.description||'Extra work').slice(0,160),detail:flag.reason==='over_quantity'?'Quantity is over the estimate. The field confirmed it as extra work.':'No estimate line matches. The field confirmed it as extra work.',quantity:flag.quantity==null?null:Number(flag.quantity)||0,unit:String(flag.unit||'').slice(0,20),status:'Potential'}));
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

  return {normalizeUnit,matchEstimateLine,reviewScope,decideFlag,confirmedExtraChanges,approvedQuantityMap,hoursFromClock,submissionStatus,QUANTITY_TOLERANCE,PRODUCTIVITY_LIMIT};
});
