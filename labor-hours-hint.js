(function(root){
  function roundHours(value){
    const number=Number(value);
    return Number.isFinite(number)?number:0;
  }
  function parseCrewSplit(laborText){
    const text=String(laborText||'');
    const times=text.match(/(\d+(?:\.\d+)?)\s*(?:people|persons?|workers?|carpenters?|guys?|men|man|crew(?:\s+members?)?)?\s*[×x]\s*(\d+(?:\.\d+)?)/i);
    if(times)return {count:Number(times[1]),each:Number(times[2])};
    const paired=text.match(/(\d+(?:\.\d+)?)\s*(?:people|persons?|workers?|carpenters?|guys?|men|man)\s*(?:·|-|,)?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
    if(paired)return {count:Number(paired[1]),each:Number(paired[2])};
    const hoursEach=text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:each|apiece)/i);
    const countOnly=text.match(/(\d+(?:\.\d+)?)\s*(?:people|persons?|workers?|carpenters?|guys?|men|man)\b/i);
    if(hoursEach&&countOnly)return {count:Number(countOnly[1]),each:Number(hoursEach[1])};
    return null;
  }
  function hintFor(member,allocated,parsed){
    const hours=Number.isInteger(allocated)?String(allocated):String(Math.round(allocated*100)/100);
    const who=member.name||'this person';
    const why=parsed&&parsed.count>1?`AI allocated ${hours} labor hours on the work lines for ${parsed.count} people.`:`AI allocated ${hours} labor hours on the work lines.`;
    return {memberId:member.memberId,message:`${why} Enter the hours ${who} worked so the crew total matches. This is a suggestion you can edit. Nothing is submitted until you send the daily.`};
  }
  function suggestLaborHours({members,allocatedHours,laborText,existingEntries}={}){
    const allocated=roundHours(allocatedHours);
    const roster=(members||[]).map(member=>{
      const memberId=Number(member.memberId??member.id);
      const saved=(existingEntries||[]).find(entry=>Number(entry.memberId)===memberId);
      return {memberId,name:String(member.name||'').trim(),hours:roundHours(saved?.hours??member.hours)};
    }).filter(member=>member.memberId);
    const unchanged={autoSubmitted:false,mode:'unchanged',entries:roster.map(member=>({memberId:member.memberId,hours:member.hours})),hints:[]};
    if(!roster.length||!(allocated>0))return unchanged;
    const crewTotal=roster.reduce((sum,member)=>sum+member.hours,0);
    if(crewTotal>0)return unchanged;
    const parsed=parseCrewSplit(laborText);
    return {autoSubmitted:false,mode:'hint',entries:roster.map(member=>({memberId:member.memberId,hours:0})),hints:roster.map(member=>hintFor(member,allocated,parsed))};
  }
  root.suggestLaborHours=suggestLaborHours;
  if(typeof module==='object'&&module.exports)module.exports={suggestLaborHours};
})(typeof globalThis!=='undefined'?globalThis:this);
