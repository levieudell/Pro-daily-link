'use strict';
// Curated product guidance only. No AI provider, account-data answers or actions.
const TIPS = Object.freeze([
  {id:'project',roles:['owner','admin'],title:'Start with one project',text:'Open Projects and add your first job. Add the scope you want to track before your crew records production.'},
  {id:'crew',roles:['owner','admin'],title:'Give your crew a clear starting point',text:'Open Team to add employees and organize crews. The Account Owner can choose app access and create a temporary password for each person who needs a login.'},
  {id:'daily',roles:['owner','admin'],title:'Try your first daily',text:'Open a project and create a daily. Check the job, date, quantities and labor, then save a draft or submit it to the office for review.'},
  {id:'field-daily',roles:['field','foreman','project_manager'],title:'Check your daily before submitting',text:'On work you can access, check the job and date, describe what happened, and review quantities and labor before submitting. Save a draft if you need to finish later.'}
]);
function preferences(user){return {inApp:user.helpGuidance?.inApp!==false,emailTips:['owner','admin'].includes(user.role)&&user.helpGuidance?.emailTips===true};}
function guidance(db,user,day){
  const state=user.helpGuidance||{},submitted=row=>['Needs review','Approved'].includes(row.status),completed={project:(db.projects||[]).length>0,crew:(db.team||[]).some(row=>row.crew&&!/^(office|unassigned)$/i.test(row.crew)),daily:(db.reports||[]).some(submitted),'field-daily':(db.reports||[]).some(row=>submitted(row)&&((user.name&&row.foreman===user.name)||(user.memberId&&(row.laborEntries||[]).some(entry=>Number(entry.memberId)===Number(user.memberId)))))};
  const tips=TIPS.filter(t=>t.roles.includes(user.role)&&!completed[t.id]&&!(state.dismissed||[]).includes(t.id)&&(!(state.seenIds||[]).includes(t.id)||state.shownDay===day&&state.shownTip===t.id));
  const prefs=preferences(user),shown=state.shownDay===day?tips.find(t=>t.id===state.shownTip):tips[0];
  return {welcome:'Welcome to Pro Daily Link. Need a hand getting started? Choose a topic below for practical help.',tip:prefs.inApp?(shown||null):null,preferences:prefs,emailDelivery:'disabled',emailAudience:['owner','admin'].includes(user.role),source:'Curated product help; no AI or private account answers.'};
}
function update(user,input,day,available){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['inApp','emailTips','dismiss','seen'].includes(k)))throw new Error('Invalid help preference');
  for(const key of ['inApp','emailTips'])if(key in input&&typeof input[key]!=='boolean')throw new Error('Use true or false for preferences');
  if(input.emailTips===true&&!['owner','admin'].includes(user.role))throw new Error('Email tips are available only to owners and admins');
  for(const key of ['dismiss','seen'])if(key in input&&(!TIPS.some(t=>t.id===input[key]&&t.roles.includes(user.role))||input[key]!==available?.id))throw new Error('Tip is no longer available');
  const state=user.helpGuidance ||= {dismissed:[]};
  for(const key of ['inApp','emailTips'])if(key in input)state[key]=input[key];
  if(input.dismiss)state.dismissed=[...new Set([...(state.dismissed||[]),input.dismiss])];
  if(input.seen){state.shownDay=day;state.shownTip=input.seen;state.seenIds=[...new Set([...(state.seenIds||[]),input.seen])];}
  return preferences(user);
}
function emailPreview(db,user,day){
  if(!['owner','admin'].includes(user.role))return null;
  const value=guidance(db,{...user,helpGuidance:{...user.helpGuidance,inApp:true}},day),tip=value.tip;
  if(!value.preferences.emailTips||!tip)return null;
  return {status:'draft-only',dedupeKey:JSON.stringify([db.company.id,user.id,'help-v1',tip.id]),subject:`A helpful PDL tip: ${tip.title}`,body:`${tip.text}\n\nYou chose optional PDL setup tips. Turn off Email setup tips in Help Center preferences at any time.`,requiresBeforeDelivery:['Reviewed customer copy','Signed unsubscribe URL and one-click handling','Atomic unique dedupe ledger and retry policy','Fresh consent, role, tenant and completion check'],deliveryEnabled:false};
}
module.exports={TIPS,preferences,guidance,update,emailPreview};
