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
  function planLaborHourHints({workLineHours,members,laborText}={}){
    const allocated=(workLineHours||[]).reduce((sum,value)=>sum+(Number(value)||0),0);
    const roster=(members||[]).map(member=>({memberId:Number(member.memberId??member.id),name:String(member.name||'').trim(),hours:Number(member.hours)||0})).filter(member=>member.memberId);
    return suggestLaborHours({members:roster,allocatedHours:allocated,laborText,existingEntries:roster});
  }
  function renderLaborHourHints(root,{laborText=''}={}){
    if(!root||typeof root.querySelectorAll!=='function')return {autoSubmitted:false,mode:'unchanged',entries:[],hints:[]};
    const workLineHours=[...root.querySelectorAll('.production-hours')].map(input=>input.value);
    const memberInputs=[...root.querySelectorAll('[data-labor-member]')];
    const members=memberInputs.map(input=>{
      const line=typeof input.closest==='function'?input.closest('.labor-line'):null;
      const name=line&&typeof line.querySelector==='function'?line.querySelector('strong')?.textContent||'':'';
      return {memberId:Number(input.getAttribute?.('data-labor-member')||input.dataset?.laborMember),name,hours:Number(input.value)||0,line};
    }).filter(member=>member.memberId);
    const before=memberInputs.map(input=>String(input.value));
    const plan=planLaborHourHints({workLineHours,members,laborText});
    root.querySelectorAll('.labor-hours-hint').forEach(node=>node.remove());
    const doc=root.ownerDocument||root;
    const noteFor=message=>{const note=doc.createElement('p');note.className='labor-hours-hint';note.textContent=message;return note};
    if(!members.length){
      const allocated=workLineHours.reduce((sum,value)=>sum+(Number(value)||0),0);
      const list=typeof root.querySelector==='function'?root.querySelector('#report-labor-list'):null;
      if(allocated>0&&list){
        const hours=Number.isInteger(allocated)?String(allocated):String(Math.round(allocated*100)/100);
        const note=noteFor(`AI allocated ${hours} labor hours on the work lines. Enter each person's hours so the crew total matches. Nothing is submitted until you send the daily.`);
        if(typeof list.prepend==='function')list.prepend(note);else list.append(note);
      }
    }else if(plan&&plan.mode==='hint'&&plan.autoSubmitted!==true){
      for(const hint of plan.hints||[]){
        const member=members.find(row=>row.memberId===Number(hint.memberId));
        if(!member?.line)continue;
        member.line.append(noteFor(hint.message));
      }
    }
    memberInputs.forEach((input,index)=>{if(String(input.value)!==before[index])input.value=before[index]});
    return plan;
  }
  root.suggestLaborHours=suggestLaborHours;
  root.planLaborHourHints=planLaborHourHints;
  root.renderLaborHourHints=renderLaborHourHints;
  if(typeof module==='object'&&module.exports)module.exports={suggestLaborHours,planLaborHourHints,renderLaborHourHints};
})(typeof globalThis!=='undefined'?globalThis:this);
