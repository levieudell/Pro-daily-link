(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDLAssistantNames=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/['’]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
  const projectName=value=>normalize(value).split(' ').map(word=>({st:'street',rd:'road',ave:'avenue',av:'avenue'}[word]||word)).join(' ');
  function projectMention(text){
    const header=String(text).split(/\b(?:task|instructions)\s*:|:\s|\b(?:note|to-do|todo)\s+that\b/i)[0];
    const match=header.match(/\b(?:at|for|in|project)\s+(?:project\s+)?(.+?)(?=\s+(?:on|from|across|between|today|tomorrow)\b|[;:!?]|$)/i);
    if(!match)return null;const phrase=match[1].trim(),start=match.index+match[0].length-match[1].length+match[1].length-match[1].trimStart().length;return {phrase,start,end:start+phrase.length};
  }
  function projectPhrase(text,answer=false){return answer?String(text).trim():projectMention(text)?.phrase||'';}
  function projectsFor(text,projects,answer=false){
    const header=answer?String(text):String(text).split(/\b(?:task|instructions)\s*:|:\s|\b(?:note|to-do|todo)\s+that\b/i)[0];
    const phrase=projectPhrase(text,answer),query=projectName(phrase);
    const direct=normalize(phrase).match(/^(?:project )?id (\d+)$/),ids=[...header.matchAll(/\bproject\s+id\s+(\d+)\b/gi)].map(match=>Number(match[1]));
    if(direct){const id=Number(direct[1]);return {id:projects.some(row=>Number(row.id)===id)&&ids.every(value=>value===id)?id:null,choices:[],phrase};}
    if(ids.length)return {id:null,choices:[]};
    if(!query)return {id:null,choices:[]};
    const exact=projects.filter(row=>projectName(row.name)===query);
    if(exact.length)return {id:exact.length===1?Number(exact[0].id):null,choices:exact,phrase};
    if(/\b(?:or|and|not|except|instead of|dont use|don't use|do not use)\b/i.test(phrase))return {id:null,choices:[]};
    const partial=projects.filter(row=>(' '+projectName(row.name)+' ').includes(' '+query+' '));
    return {id:partial.length===1&&query.split(' ').length>=2?Number(partial[0].id):null,choices:partial,phrase};
  }
  function distance(a,b){if(Math.abs(a.length-b.length)>1)return 2;let previous=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));previous=row;}return previous[b.length];}
  function candidates(part,members,near=true,includeNearExact=false){
    const text=normalize(part),id=text.match(/^id (\d+)$/);
    if(!text)return [];
    if(id)return members.filter(row=>Number(row.id)===Number(id[1])).map(row=>({id:Number(row.id),near:false}));
    const exact=members.filter(row=>normalize(row.name)===text);
    if(exact.length){const extra=includeNearExact&&text.length>=3&&!text.includes(' ')?members.filter(row=>!exact.includes(row)&&distance(text,normalize(row.name).split(' ')[0])===1):[];return [...exact.map(row=>({id:Number(row.id),near:false})),...extra.map(row=>({id:Number(row.id),near:true}))];}
    const first=members.filter(row=>normalize(row.name).split(' ')[0]===text);
    if(first.length){const extra=includeNearExact&&text.length>=3?members.filter(row=>!first.includes(row)&&distance(text,normalize(row.name).split(' ')[0])===1):[];return [...first.map(row=>({id:Number(row.id),near:false})),...extra.map(row=>({id:Number(row.id),near:true}))];}
    return near&&text.length>=3&&!text.includes(' ')?members.filter(row=>distance(text,normalize(row.name).split(' ')[0])<=1).map(row=>({id:Number(row.id),near:true})):[];
  }
  function peopleFor(text,members,multiple=true){
    const raw=String(text).trim();if(!raw||/\b(?:or|not|except|instead)\b/i.test(raw))return {ids:null,choices:[]};
    const explicit=/[,;&]|\band\b/i.test(raw),parts=raw.split(/\s*(?:[,;&]|\band\b)\s*/i);
    let groups=parts.map(part=>candidates(part,members)),missingConjunction=false;
    if(parts.length===1&&!groups[0].length){
      // Partition only the supplied name words; never drop an unknown word.
      const words=normalize(raw).split(' '),paths=[];let visited=0,truncated=false;
      function walk(index,path){if(++visited>200||paths.length>=20){truncated=true;return;}if(path.length>10)return;if(index===words.length){paths.push(path);return;}for(let end=index+1;end<=Math.min(words.length,index+5);end++){const rows=candidates(words.slice(index,end).join(' '),members,true,true);if(rows.length)walk(end,[...path,rows]);}}
      if(words.length<=20)walk(0,[]);
      if(truncated||paths.length!==1)return {ids:null,choices:[]};groups=paths[0];missingConjunction=groups.length>1;
    }
    if(!groups.length||groups.length>10||groups.some(rows=>!rows.length)||!multiple&&groups.length!==1)return {ids:null,choices:[]};
    let choices=[[]];for(const rows of groups){const next=[];for(const choice of choices)for(const row of rows)if(!choice.includes(row.id))next.push([...choice,row.id]);choices=next.slice(0,20);}
    choices=[...new Map(choices.map(ids=>[ids.join(','),ids])).values()];
    const certain=choices.length===1&&!missingConjunction&&!groups.some(rows=>rows.some(row=>row.near));
    return {ids:certain?choices[0]:null,choices,missingConjunction,explicit};
  }
  function relativeDate(text,today){
    const value=normalize(text);if(!['today','tomorrow'].includes(value)||!/^\d{4}-\d{2}-\d{2}$/.test(today||''))return null;
    const date=new Date(today+'T12:00:00Z');if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==today)return null;
    if(value==='tomorrow')date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10);
  }
  return {normalize,projectMention,projectPhrase,projectsFor,peopleFor,relativeDate};
});
