(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DailyWorkExtraction=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const verbs='started|starting|installed|installing|added|adding|tiled|tiling|painted|painting|repaired|repairing|replaced|replacing|patched|patching|finished|finishing|removed|removing|poured|pouring|placed|placing|set|framed|framing|excavated|completed|stripped|cleaned|cleaning|swept|sweeper|sweeping|measured|measuring|worked on|working on|carpet off|instalamos|instalado|colocamos|vaciamos|agregamos|limpiamos|barrimos|medimos|empezamos|terminamos|quitamos';
  const work=new RegExp('\\b(?:'+verbs+')\\b','i');
  const words={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
  const quantities=new RegExp('\\b(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|'+Object.keys(words).join('|')+')\\s+(?:more\\s+)?(square\\s+feet|sq\\.?\\s*ft|yards?|yds?|cy|panels?|tiles?|feet|ft|tons?|units?|squares?|sf|lf|ea|pies|yardas|baldosas)\\b','gi');
  function unit(raw){return /^(square\s+feet|sq\.?\s*ft|squares?|sf)$/.test(raw)?'SF':/^(yards?|yds?|cy|yardas)$/.test(raw)?'CY':/^(feet|ft|lf|pies)$/.test(raw)?'LF':/^(units?|panels?|tiles?|ea|baldosas)$/.test(raw)?'EA':/^tons?$/.test(raw)?'TON':''}
  function propose(notes){
    const split=new RegExp(';\\s*|,\\s+(?=(?:we\\s+)?(?:'+verbs+')\\b)|\\band\\s+(?=(?:we\\s+)?(?:'+verbs+')\\b)','i');
    const clauses=String(notes||'').replace(/^field work recorded:\s*/i,'').split(/(?<=[.!?])\s+|\n+/).flatMap(text=>text.split(split));
    const rows=[];
    for(const clause of clauses){const description=clause.trim(),futureOnly=/^(?:painting|repairing|replacing|patching|finishing)\s+(?:is|was|will be)\s+(?:planned|scheduled)\b/i.test(description)&&!/\b(?:painted|repaired|replaced|patched|finished|completed|installed)\b/i.test(description);if(!description||!work.test(description)||futureOnly||/^(?:(?:(?:we|i)\s+)?(?:will|plan|need|did not|didn't|have not|haven't)|tomorrow|next|not|no work|no activity|safety|hazard|incident|no|ma[ñn]ana|vamos a)\b/i.test(description))continue;
      quantities.lastIndex=0;const matches=[...description.matchAll(quantities)],measurement=/\b(?:measur(?:ed|ing)|medimos)\b/i.test(description);
      // A dimension measured is not a quantity installed. Ambiguous multiple quantities stay pending.
      const match=!measurement&&matches.length===1?matches[0]:null;
      rows.push({description:description.slice(0,1000),quantity:match?(Object.hasOwn(words,match[1].toLowerCase())?words[match[1].toLowerCase()]:Number(match[1].replaceAll(',',''))):null,unit:match?unit(match[2].toLowerCase()):'',laborHours:0,needsScopeConfirmation:true,needsLaborConfirmation:true,potentialExtraWork:/\b(?:extra work|unplanned|out of scope|outside (?:the )?estimate)\b/i.test(description)});
    }
    return rows.slice(0,40);
  }
  function reviewSuggestions(rows){return (Array.isArray(rows)?rows:[]).slice(0,40).filter(row=>row&&typeof row==='object').map(row=>({description:String(row.description||'').slice(0,1000),estimateItemId:typeof row.estimateItemId==='number'||typeof row.estimateItemId==='string'?row.estimateItemId:null,custom:row.custom===true,quantity:row.quantity==null||row.quantity===''?null:Number.isFinite(Number(row.quantity))?Math.max(0,Number(row.quantity)):null,unit:String(row.unit||'').slice(0,20),laborHours:Math.max(0,Number(row.laborHours)||0),needsScopeConfirmation:row.needsScopeConfirmation===true,needsLaborConfirmation:row.needsLaborConfirmation===true,potentialExtraWork:row.potentialExtraWork===true,...(row.scopeEvidence?{scopeEvidence:String(row.scopeEvidence).slice(0,1000)}:{}),...(row.scopeUnverified===true?{scopeUnverified:true}:{}),...(row.scopeChoice==='review'?{scopeChoice:'review'}:{})})).filter(row=>row.description||row.estimateItemId!=null)}
  function normalize(lines,notes){
    const supplied=Array.isArray(lines)?lines.filter(line=>line&&String(line.description||'').trim()):[];
    if(!supplied.length)return propose(notes);
    const comparable=text=>String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const sources=propose(notes),anchor=(line,source)=>{const text=comparable(source.description),evidence=comparable(line.evidence),description=comparable(line.description);return description===text||evidence.length>=8&&(text.includes(evidence)||evidence.includes(text))};
    const rows=supplied.map(line=>{const matches=sources.filter(source=>anchor(line,source)),scopeSource=matches.length===1?matches[0]:null,source=scopeSource&&supplied.filter(other=>anchor(other,scopeSource)).length===1?scopeSource:null;return {...line,scopeEvidence:scopeSource?.description||'',scopeUnverified:!scopeSource,quantity:source?.quantity??null,unit:source?.unit||'',laborHours:Math.max(0,Number(line.laborHours)||0),needsScopeConfirmation:true,needsLaborConfirmation:true,potentialExtraWork:source?.potentialExtraWork===true||line.potentialExtraWork===true||/\b(?:extra work|unplanned|out of scope|outside (?:the )?estimate)\b/i.test(String(line.description))}});
    for(const source of sources){
      const text=comparable(source.description),covered=rows.some(line=>{const evidence=comparable(line.evidence),description=comparable(line.description);return description===text||evidence.length>=8&&(text.includes(evidence)||evidence.includes(text))});
      // A provider may rename a scope. Keep unmatched source facts visible without
      // repeating a possibly already represented quantity or inferring an extra.
      if(!covered)rows.push({...source,quantity:null,unit:'',sourceOnly:true});
    }
    return rows.slice(0,40);
  }
  function groundReviewSuggestions(rows,notes){return (Array.isArray(rows)?rows:[]).map(row=>{
    if(!row||!row.needsScopeConfirmation||row.custom||row.estimateItemId!=null||row.scopeEvidence||row.scopeUnverified)return row;
    // Older Drafts did not retain provider evidence. Keep entered quantities and
    // hours intact while refusing to infer scope from an ungrounded saved label.
    const grounded=normalize([row],notes)[0];
    return {...row,...(grounded?.scopeEvidence?{scopeEvidence:grounded.scopeEvidence}:{}),scopeUnverified:grounded?.scopeUnverified!==false};
  })}
  // Scope suggestions never create estimate lines or approve extra work. A shared
  // material word cannot establish the surface, activity, or location performed.
  function scopeFacts(raw){
    const text=String(raw||'').toLowerCase(),has=pattern=>pattern.test(text);
    const categories=[];
    if(has(/\b(?:clean(?:ed|ing)?|sweep(?:ing|er)?|swept|limpiamos|barrimos)\b/))categories.push('clean');
    if(has(/\b(?:measur(?:e|ed|ing)|medimos)\b/))categories.push('measure');
    if(has(/\b(?:trim|baseboards?|moulding|molding)\b/))categories.push('trim');
    if(has(/\b(?:paint(?:ed|ing)?|pintamos)\b/))categories.push('paint');
    if(has(/\b(?:plumbing|pipes?|tuber[ií]a|drains?)\b/))categories.push('plumbing');
    if(has(/\b(?:concrete|cement|slab|concreto)\b/))categories.push('concrete');
    if(has(/\b(?:fram(?:e|ed|ing)|framing)\b/))categories.push('framing');
    if(has(/\b(?:drywall|sheetrock)\b/))categories.push('drywall');
    if(has(/\b(?:roof(?:ing)?|shingles?)\b/))categories.push('roof');
    if(has(/\b(?:excavat(?:ed|ing|ion)|grading)\b/))categories.push('earth');
    if(has(/\b(?:electrical|wiring|outlets?)\b/))categories.push('electrical');
    const materials=[];
    if(has(/\b(?:tiles?|tiled|tiling|baldosas)\b/))materials.push('tile');
    if(has(/\b(?:lvp|lvt|vinyl)\b/))materials.push('vinyl');
    if(has(/\bcarpet(?:ing)?\b/))materials.push('carpet');
    if(has(/\b(?:hardwood|wood flooring)\b/))materials.push('wood');
    if(has(/\blaminate\b/))materials.push('laminate');
    // Activity takes precedence: cleaning/measuring an existing floor is not
    // flooring production. Multiple activities/surfaces stay in human review.
    const finishContext=materials.length||has(/\bfloor(?:s|ing)?\b/),finishAction=has(/\b(?:installed|installing|added|adding|tiled|tiling|started|starting)\b[^.!;]{0,120}\b(?:tiles?|floor(?:ing)?|lvp|vinyl|carpet|hardwood|laminate)\b/);
    if(finishContext&&(!categories.length||!categories.every(value=>value==='clean'||value==='measure')||finishAction))categories.push('finish');
    const surfaces=[];
    if(has(/\bwalls?\b/))surfaces.push('wall');
    if(has(/\bceilings?\b/))surfaces.push('ceiling');
    if(has(/\bfloor(?:s|ing)?\b/)||materials.some(value=>value!=='tile'))surfaces.push('floor');
    const rooms=['bathroom','kitchen','bedroom','hallway','laundry','garage','stairs'].filter(room=>new RegExp('\\b'+room+'s?\\b').test(text));
    const levels=[];
    if(has(/\b(?:main|ground|first|1st)\s+floor\b/))levels.push('main');
    if(has(/\b(?:second|2nd)\s+floor\b/))levels.push('second');
    if(has(/\b(?:third|3rd)\s+floor\b/))levels.push('third');
    if(has(/\bbasement\b/))levels.push('basement');
    if(has(/\bupstairs\b/)&&!levels.some(level=>level==='second'||level==='third'))levels.push('upper');
    if(has(/\bdownstairs\b/)&&!levels.some(level=>level==='main'||level==='basement'))levels.push('lower');
    return {categories,materials,surfaces,rooms,levels};
  }
  function scopeProposal(suggestion,items){
    const direct=(items||[]).find(item=>suggestion.estimateItemId!=null&&String(item.id)===String(suggestion.estimateItemId));
    if(suggestion.custom===true)return {mode:'custom',reason:'Custom work selected for office review.'};
    if(direct)return {mode:'estimate',estimateItemId:direct.id,reason:'Saved estimate selection.'};
    if(suggestion.scopeChoice==='review'||suggestion.scopeUnverified===true)return {mode:'review',reason:'Confirm the scope against the original notes.'};
    const source=scopeFacts(suggestion.scopeEvidence||suggestion.description);
    if(source.categories.length!==1||source.surfaces.length>1||source.materials.length>1||source.rooms.length>1||source.levels.length>1)return {mode:'review',reason:'Mixed or unclear scope needs your choice.'};
    if(!(items||[]).length)return {mode:'custom',reason:'No estimate lines are available. Possible extra work needs office review.'};
    const results=items.map(item=>{const target=scopeFacts(item.name);
      if(target.categories.length!==1)return {item,state:'unclear'};
      if(source.categories[0]!==target.categories[0])return {item,state:'different'};
      for(const key of ['materials','surfaces','rooms']){
        if(source[key].length&&target[key].length&&!source[key].some(value=>target[key].includes(value)))return {item,state:'different'};
      }
      if(source.levels.length&&target.levels.length&&source.levels[0]!==target.levels[0]){
        const pair=[source.levels[0],target.levels[0]];
        if(pair.includes('upper')&&pair.some(value=>value==='second'||value==='third')||pair.includes('lower')&&pair.some(value=>value==='main'||value==='basement'))return {item,state:'unclear'};
        return {item,state:'different'};
      }
      if(target.materials.length>1||target.surfaces.length>1||target.rooms.length>1||target.levels.length>1)return {item,state:'unclear'};
      if(source.categories[0]==='finish'&&(!source.surfaces.length||!target.surfaces.length))return {item,state:'unclear'};
      if(['materials','rooms','levels'].some(key=>target[key].length&&!source[key].length))return {item,state:'unclear'};
      return {item,state:'match'};
    });
    const matches=results.filter(result=>result.state==='match');
    if(matches.length===1&&!results.some(result=>result.state==='unclear'))return {mode:'estimate',estimateItemId:matches[0].item.id,reason:'Scope and location fit this estimate line. Review before saving.'};
    if(results.every(result=>result.state==='different'))return {mode:'custom',reason:'This work differs from the estimate scope. Possible extra work needs office review.'};
    return {mode:'review',reason:'The estimate match is unclear. Choose a line or use custom work.'};
  }
  return {propose,normalize,reviewSuggestions,groundReviewSuggestions,scopeProposal};
});
