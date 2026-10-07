(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DailyWorkExtraction=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const verbs='started|starting|installed|installing|added|adding|removed|removing|poured|pouring|placed|placing|set|framed|framing|excavated|completed|stripped|cleaned|cleaning|swept|sweeper|sweeping|measured|measuring|worked on|working on|carpet off|instalamos|instalado|colocamos|vaciamos|agregamos|limpiamos|barrimos|medimos|empezamos|terminamos|quitamos';
  const work=new RegExp('\\b(?:'+verbs+')\\b','i');
  const words={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
  const quantities=new RegExp('\\b(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|'+Object.keys(words).join('|')+')\\s+(?:more\\s+)?(square\\s+feet|sq\\.?\\s*ft|yards?|yds?|cy|panels?|tiles?|feet|ft|tons?|units?|squares?|sf|lf|ea|pies|yardas|baldosas)\\b','gi');
  function unit(raw){return /^(square\s+feet|sq\.?\s*ft|squares?|sf)$/.test(raw)?'SF':/^(yards?|yds?|cy|yardas)$/.test(raw)?'CY':/^(feet|ft|lf|pies)$/.test(raw)?'LF':/^(units?|panels?|tiles?|ea|baldosas)$/.test(raw)?'EA':/^tons?$/.test(raw)?'TON':''}
  function propose(notes){
    const split=new RegExp(';\\s*|,\\s+(?=(?:we\\s+)?(?:'+verbs+')\\b)|\\band\\s+(?=(?:we\\s+)?(?:'+verbs+')\\b)','i');
    const clauses=String(notes||'').replace(/^field work recorded:\s*/i,'').split(/(?<=[.!?])\s+|\n+/).flatMap(text=>text.split(split));
    const rows=[];
    for(const clause of clauses){const description=clause.trim();if(!description||!work.test(description)||/^(?:(?:we\s+)?(?:will|plan|need|did not|didn't|have not|haven't)|tomorrow|next|not|no work|no activity|safety|hazard|incident|no|ma[ñn]ana|vamos a)\b/i.test(description))continue;
      quantities.lastIndex=0;const matches=[...description.matchAll(quantities)],measurement=/\b(?:measur(?:ed|ing)|medimos)\b/i.test(description);
      // A dimension measured is not a quantity installed. Ambiguous multiple quantities stay pending.
      const match=!measurement&&matches.length===1?matches[0]:null;
      rows.push({description:description.slice(0,1000),quantity:match?(Object.hasOwn(words,match[1].toLowerCase())?words[match[1].toLowerCase()]:Number(match[1].replaceAll(',',''))):null,unit:match?unit(match[2].toLowerCase()):'',laborHours:0,needsScopeConfirmation:true,needsLaborConfirmation:true,potentialExtraWork:/\b(?:extra work|unplanned|out of scope|outside (?:the )?estimate)\b/i.test(description)});
    }
    return rows.slice(0,40);
  }
  function reviewSuggestions(rows){return (Array.isArray(rows)?rows:[]).slice(0,40).filter(row=>row&&typeof row==='object').map(row=>({description:String(row.description||'').slice(0,1000),estimateItemId:typeof row.estimateItemId==='number'||typeof row.estimateItemId==='string'?row.estimateItemId:null,custom:row.custom===true,quantity:row.quantity==null||row.quantity===''?null:Number.isFinite(Number(row.quantity))?Math.max(0,Number(row.quantity)):null,unit:String(row.unit||'').slice(0,20),laborHours:Math.max(0,Number(row.laborHours)||0),needsScopeConfirmation:row.needsScopeConfirmation===true,needsLaborConfirmation:row.needsLaborConfirmation===true,potentialExtraWork:row.potentialExtraWork===true})).filter(row=>row.description||row.estimateItemId!=null)}
  function normalize(lines,notes){
    const supplied=Array.isArray(lines)?lines.filter(line=>line&&String(line.description||'').trim()):[];
    if(!supplied.length)return propose(notes);
    const comparable=text=>String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const sources=propose(notes),anchor=(line,source)=>{const text=comparable(source.description),evidence=comparable(line.evidence),description=comparable(line.description);return description===text||evidence.length>=8&&(text.includes(evidence)||evidence.includes(text))};
    const rows=supplied.map(line=>{const matches=sources.filter(source=>anchor(line,source)),source=matches.length===1&&supplied.filter(other=>anchor(other,matches[0])).length===1?matches[0]:null;return {...line,quantity:source?.quantity??null,unit:source?.unit||'',laborHours:Math.max(0,Number(line.laborHours)||0),needsScopeConfirmation:true,needsLaborConfirmation:true,potentialExtraWork:source?.potentialExtraWork===true||line.potentialExtraWork===true||/\b(?:extra work|unplanned|out of scope|outside (?:the )?estimate)\b/i.test(String(line.description))}});
    for(const source of sources){
      const text=comparable(source.description),covered=rows.some(line=>{const evidence=comparable(line.evidence),description=comparable(line.description);return description===text||evidence.length>=8&&(text.includes(evidence)||evidence.includes(text))});
      // A provider may rename a scope. Keep unmatched source facts visible without
      // repeating a possibly already represented quantity or inferring an extra.
      if(!covered)rows.push({...source,quantity:null,unit:'',sourceOnly:true});
    }
    return rows.slice(0,40);
  }
  return {propose,normalize,reviewSuggestions};
});
