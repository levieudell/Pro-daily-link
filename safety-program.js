'use strict';

const crypto = require('node:crypto');
const { validDate } = require('./schedule-availability');
const { CATALOG } = require('./safety-engine');
const RULE = 'https://osha.oregon.gov/rules/final/division-1/Pages/437-001-0760-0765.aspx';
const clone = value => structuredClone(value);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const text = (value, label, max = 4000) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`Enter valid ${label}.`);
  return value.trim();
};
const required = (value, label, max) => { const result = text(value, label, max); if (!result) fail(`Enter ${label}.`); return result; };
const office = user => ['owner', 'admin'].includes(user.role);
const manager = user => office(user) || user.role === 'project_manager' && user.permissions?.manageSafety === true;
const verify = user => office(user) || user.role === 'project_manager' && user.permissions?.verifySafety === true;
const active = row => !row.deletedAt && !row.archived && !['Inactive', 'Deactivated'].includes(row.status);
const own = (db, rows) => (rows || []).filter(row => row.companyId === db.company.id);
const revision = (input, row) => { if (input.revision !== row.revision) fail('This record changed. Refresh before saving.', 409); };
const today = db => new Intl.DateTimeFormat('en-CA', { timeZone: db.company.timezone || 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

function starterTopics() {
  return CATALOG.map(row => ({ id: `starter-${row.id}`, revision: 1, title: row.label, language: 'en', status: 'Published', source: row.source,
    content: `${row.description}\nDiscuss the actual work and conditions on this job.\nAsk the crew what has changed and what could hurt someone.\nRecord hazards, immediate controls and who will follow up.\nThis discussion starter does not replace task-specific training or a qualified person's inspection.`,
    updatedAt: '2026-10-31T00:00:00.000Z', origin: 'PDL starter' }));
}
function platformTopics(platform) {
  const saved = platform.safetyTopics || [];
  return [...starterTopics().filter(row => !saved.some(item => item.id === row.id)), ...saved];
}
function topicPayload(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) fail('Enter topic details.');
  if (!['en','es'].includes(input.language)) fail('Choose English or Spanish.');
  if (!['Draft','Published','Archived'].includes(input.status)) fail('Choose Draft, Published or Archived.');
  const source = text(input.source || '', 'reference link', 1000);
  if (source && !/^https:\/\//i.test(source)) fail('Use an https reference link.');
  return { title:required(input.title,'a topic title',200), content:required(input.content,'the discussion guide',12000), language:input.language, status:input.status, source };
}
function saveTopic(rows, input, user, current, companyId) {
  const payload = topicPayload(input), at = new Date().toISOString();
  if (current) revision(input, current);
  const next = { id:current?.id || crypto.randomUUID(), ...(companyId ? {companyId} : {}), ...payload, revision:(current?.revision || 0)+1,
    createdAt:current?.createdAt || at, updatedAt:at, updatedBy:user.name,
    history:[...(current?.history || []), ...(current ? [{at,by:user.name,revision:current.revision,title:current.title,content:current.content,language:current.language,status:current.status,source:current.source}] : [])] };
  const index = rows.findIndex(row => row.id === next.id); if (index < 0) rows.push(next); else rows[index] = next;
  return next;
}
function dates(start, frequency, count) {
  if (!validDate(start)) fail('Choose a valid meeting date.');
  if (!['once','weekly','monthly'].includes(frequency)) fail('Choose once, weekly or monthly.');
  if (!Number.isInteger(count) || count < 1 || count > 52 || frequency === 'once' && count !== 1) fail('Choose 1 to 52 meetings; a one-time meeting has one date.');
  return Array.from({length:count}, (_, index) => {
    const date = new Date(start+'T12:00:00Z');
    if (frequency === 'weekly') date.setUTCDate(date.getUTCDate()+index*7);
    if (frequency === 'monthly') { const day=date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth()+index); const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate(); date.setUTCDate(Math.min(day,last)); }
    return date.toISOString().slice(0,10);
  });
}
function audit(row, user, action, detail = '') {
  row.history ||= []; row.history.push({at:new Date().toISOString(),by:user.name,userId:user.id,action,detail}); row.revision++;
}
function meetingVisible(db, user, row, canAccessProject) {
  if (office(user)) return true;
  if (user.role === 'project_manager') return row.projectId != null && canAccessProject(db,user,row.projectId);
  if (!['field','foreman'].includes(user.role)) return false;
  return row.presenterId === user.id || row.invited.some(person => person.memberId === Number(user.memberId)) || row.kind === 'committee' && row.status === 'completed';
}
function projectedMeeting(row, user) {
  return {...clone(row), canRecord:office(user) || row.presenterId === user.id, canAcknowledge:row.status === 'completed' && row.attendees.some(person => person.memberId === Number(user.memberId)) && !row.acknowledgments.some(person => person.memberId === Number(user.memberId))};
}

function createSafetyProgramHandler({readDb,writeDb,readPlatform,body,json,authenticatedUser,canAccessProject,canAccessMember,canAccessDate=()=>true}) {
  return async (req,res,url) => {
    const route=url.pathname.match(/^\/api\/safety\/(overview|topics|meetings|export)(?:\/([^/]+))?(?:\/(complete|amend|cancel|acknowledge|actions)(?:\/([^/]+))?)?$/);
    if (!route) return false;
    const reply=(status,data)=>{json(res,status,data);return true;};
    try {
      const db=clone(readDb()),user=authenticatedUser(req,db);
      if (!user || !active(user) || user.companyId && user.companyId !== db.company.id) return reply(401,{error:'Authentication required'});
      if (!['owner','admin','project_manager','foreman','field'].includes(user.role)) return reply(403,{error:'Safety access required'});
      const meetings=own(db,db.safetyMeetings).filter(row=>meetingVisible(db,user,row,canAccessProject));
      const projects=(db.projects || []).filter(row=>active(row)&&canAccessProject(db,user,Number(row.id)));
      const roster=(db.team || []).filter(row=>active(row)&&canAccessMember(db,user,Number(row.id)));
      const topics=[...platformTopics(await readPlatform()).filter(row=>row.status==='Published').map(row=>({...row,origin:'PDL library'})),...own(db,db.safetyTopics).filter(row=>row.status==='Published'||manager(user)).map(row=>({...row,origin:'Company library'}))];
      if (req.method==='GET' && route[1]==='overview' && !route[2]) {
        const allowedIds=new Set(projects.map(row=>Number(row.id)));
        const days=own(db,db.safetyDays).filter(row=>allowedIds.has(row.projectId)&&canAccessDate(db,user,row.projectId,row.date));
        const hazardVersions=new Map();for(const day of [...days].sort((a,b)=>a.date.localeCompare(b.date)))for(const row of day.hazards||[])hazardVersions.set(`${day.projectId}|${row.id}`,{...row,projectId:day.projectId,date:day.date,source:'project'});
        const hazards=[...hazardVersions.values()].filter(row=>!['verified','voided'].includes(row.status));
        const actions=meetings.flatMap(row=>(row.actions||[]).filter(action=>action.status!=='verified').map(action=>({...action,meetingId:row.id,projectId:row.projectId,source:'meeting'})));
        const visiblePeople=manager(user)?roster:(db.team||[]).filter(row=>active(row)&&meetings.some(meeting=>meeting.invited.some(person=>person.memberId===Number(row.id))));
        return reply(200,{today:today(db),companyName:db.company.name,canManage:manager(user),canVerify:verify(user),canCommittee:office(user),rule: RULE,
          projects:projects.map(row=>({id:row.id,name:row.name})),people:visiblePeople.map(row=>({id:Number(row.id),name:row.name,crew:row.crew || 'Office'})),
          presenters:(db.users||[]).filter(row=>active(row)&&['owner','admin','project_manager','foreman'].includes(row.role)&&(office(user)||row.id===user.id||row.memberId&&roster.some(member=>Number(member.id)===Number(row.memberId)))).map(row=>({id:row.id,name:row.name})),
          topics:topics.map(({history,...row})=>row),meetings:meetings.map(row=>projectedMeeting(row,user)),hazards,actions,
          legacyTalks:days.flatMap(day=>(day.talks||[]).map(talk=>({...talk,projectId:day.projectId,date:day.date,source:'project'}))) });
      }
      if (route[1]==='topics' && ['POST','PATCH'].includes(req.method)) {
        if (!manager(user)) return reply(403,{error:'Safety manager permission required'});
        const input=await body(req); db.safetyTopics ||= [];
        const current=route[2]&&own(db,db.safetyTopics).find(row=>row.id===route[2]);
        if (route[2]&&!current) return reply(404,{error:'Company topic not found'});
        const row=saveTopic(db.safetyTopics,input,user,current,db.company.id); writeDb(db);return reply(current?200:201,row);
      }
      if (route[1]==='export' && req.method==='GET' && !route[2]) {
        if (!manager(user)) return reply(403,{error:'Safety manager permission required'});
        const from=url.searchParams.get('from'),to=url.searchParams.get('to'),projectId=url.searchParams.get('projectId');
        if (!validDate(from)||!validDate(to)||from>to) fail('Choose a valid start and end date.');
        const permitted=new Set(projects.map(row=>Number(row.id)));
        const selected=meetings.filter(row=>row.date>=from&&row.date<=to&&(!projectId||row.projectId===Number(projectId)));
        const days=own(db,db.safetyDays).filter(row=>permitted.has(row.projectId)&&row.date>=from&&row.date<=to&&(!projectId||row.projectId===Number(projectId)));
        const pdf=await require('./safety-records-pdf')({companyName:db.company.name,from,to,meetings:selected,days,projects});
        res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="pdl-safety-${from}-to-${to}.pdf"`,'Cache-Control':'private, no-store'});res.end(pdf);return true;
      }
      if (route[1]!=='meetings') return reply(405,{error:'Method not supported'});
      if (req.method==='POST'&&!route[2]) {
        if (!manager(user)) return reply(403,{error:'Safety manager permission required'});
        const input=await body(req);
        if(!input || typeof input!=='object' || Array.isArray(input)) fail('Enter meeting details.');
        const kind=input.kind;
        if(input.requestId && (typeof input.requestId!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))) fail('Refresh before scheduling this meeting.');
        const fingerprint=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const prior=input.requestId && own(db,db.safetyMeetings).filter(row=>row.requestId===input.requestId&&row.createdById===user.id);
        if(prior?.length){if(prior[0].requestFingerprint!==fingerprint)fail('This scheduling request changed. Start a new request.',409);return reply(200,prior.map(row=>projectedMeeting(row,user)));}
        if (!['crew','committee','job-start'].includes(kind)) fail('Choose a crew talk, job-start meeting or committee meeting.');
        if (kind==='committee'&&!office(user)) return reply(403,{error:'Office permission required for committee meetings'});
        const projectId=input.projectId==null||input.projectId===''?null:Number(input.projectId),project=projects.find(row=>Number(row.id)===projectId);
        if (projectId!==null&&!project || !office(user)&&projectId===null) return reply(403,{error:'Choose a project you can manage'});
        if (kind==='job-start'&&!project) fail('Choose the project for this job-start meeting.');
        const topic=topics.find(row=>row.id===input.topicId&&row.status==='Published');
        if (!topic&&kind!=='committee') fail('Choose a published topic.');
        const presenter=(db.users||[]).find(row=>row.id===Number(input.presenterId)&&active(row)&&['owner','admin','project_manager','foreman'].includes(row.role));
        if (!presenter || !office(user)&&presenter.id!==user.id&&(!presenter.memberId||!roster.some(row=>Number(row.id)===Number(presenter.memberId)))) fail('Choose a presenter from your team.');
        if (!Array.isArray(input.invitedIds)||!input.invitedIds.length||input.invitedIds.length>500) fail('Choose the people invited.');
        const invitedIds=[...new Set(input.invitedIds.map(Number))];
        if (invitedIds.some(id=>!roster.some(row=>Number(row.id)===id))) fail('Choose active people from your team.');
        const seriesId=crypto.randomUUID(),meetingDates=dates(input.date,input.frequency,Number(input.count)),at=new Date().toISOString();
        const created=meetingDates.map(date=>({id:crypto.randomUUID(),companyId:db.company.id,seriesId,requestId:input.requestId||null,requestFingerprint:fingerprint,createdById:user.id,frequency:input.frequency,kind,date,projectId,projectName:project?.name||'Company',
          topic:topic?Object.fromEntries(Object.entries(clone(topic)).filter(([key])=>key!=='history')):{title:'Safety committee meeting',content:'Review open hazards, inspections, incident investigations and previous recommendations. Record decisions, management responses and follow-up owners.',language:'en',revision:1,source:RULE},
          presenterId:presenter.id,presenter:presenter.name,invited:invitedIds.map(id=>({memberId:id,name:roster.find(row=>Number(row.id)===id).name})),attendees:[],acknowledgments:[],actions:[],status:'scheduled',revision:1,createdAt:at,createdBy:user.name,history:[{at,by:user.name,userId:user.id,action:'Meeting scheduled'}]}));
        db.safetyMeetings ||= [];db.safetyMeetings.push(...created);writeDb(db);return reply(201,created.map(row=>projectedMeeting(row,user)));
      }
      const row=meetings.find(item=>item.id===route[2]);
      if (!row) return reply(404,{error:'Meeting not found'});
      if (req.method==='GET'&&!route[3]) return reply(200,projectedMeeting(row,user));
      const input=await body(req);
      if(!input || typeof input!=='object' || Array.isArray(input)) fail('Enter meeting details.');
      if (route[3]==='acknowledge'&&req.method==='POST') {
        if (row.status!=='completed'||!row.attendees.some(person=>person.memberId===Number(user.memberId))) return reply(403,{error:'Only a recorded attendee can acknowledge their own attendance'});
        if (!row.acknowledgments.some(person=>person.memberId===Number(user.memberId))) {row.acknowledgments.push({memberId:Number(user.memberId),name:user.name,userId:user.id,at:new Date().toISOString()});audit(row,user,'Attendance acknowledged');writeDb(db);}
        return reply(200,projectedMeeting(row,user));
      }
      revision(input,row);
      if (route[3]==='actions'&&route[4]&&req.method==='PATCH') {
        if (!manager(user)&&!verify(user)&&row.presenterId!==user.id) return reply(403,{error:'Presenter or safety manager permission required'});
        const action=row.actions.find(item=>item.id===route[4]); if(!action)return reply(404,{error:'Action not found'});
        if (!['corrected','verified','open'].includes(input.status)) fail('Choose a valid follow-up status.');
        if (input.status==='verified'&&!verify(user)) return reply(403,{error:'Safety verification permission required'});
        const evidence=required(input.evidence,'what was done or verified',2000);
        const before=clone(action);Object.assign(action,{status:input.status,evidence,updatedAt:new Date().toISOString(),updatedBy:user.name});
        audit(row,user,'Corrective action updated',JSON.stringify({before,after:action}));writeDb(db);return reply(200,projectedMeeting(row,user));
      }
      if (!office(user)&&row.presenterId!==user.id) return reply(403,{error:'Only the presenter or office can record this meeting'});
      if (route[3]==='cancel'&&req.method==='POST') {
        if(row.status==='cancelled')fail('This meeting is already cancelled.',409);
        const reason=required(input.reason,'a cancellation reason',1000);row.status='cancelled';audit(row,user,'Meeting cancelled',reason);writeDb(db);return reply(200,projectedMeeting(row,user));
      }
      if (['complete','amend'].includes(route[3])&&req.method==='POST') {
        if(route[3]==='complete'&&row.status!=='scheduled'||route[3]==='amend'&&row.status!=='completed')fail('Refresh this meeting before recording it.',409);
        if (row.date>today(db)) fail('A future meeting cannot be marked held.');
        const discussion=required(input.discussion,'the hazards and discussion',8000);
        if(!Array.isArray(input.attendeeIds)||!input.attendeeIds.length||input.attendeeIds.some(id=>!row.invited.some(person=>person.memberId===Number(id))))fail('Select the invited people who were actually present.');
        const attendeeIds=[...new Set(input.attendeeIds.map(Number))];
        const recommendations=text(input.recommendations||'','recommendations',4000),managementResponse=text(input.managementResponse||'','management response',4000);
        if(row.kind==='committee'&&!recommendations)fail('Record the recommendations, or state that none were made.');
        const newActions=input.actions||[];if(!Array.isArray(newActions)||newActions.length>30)fail('Add no more than 30 actions.');
        const actions=newActions.map(action=>{const owner=roster.find(person=>Number(person.id)===Number(action.ownerId));if(!owner||!validDate(action.dueDate))fail('Each action needs an owner and a valid due date.');return{id:crypto.randomUUID(),observation:required(action.observation,'the corrective action',1500),ownerId:Number(owner.id),owner:owner.name,dueDate:action.dueDate,status:'open',createdAt:new Date().toISOString()};});
        if(route[3]==='amend'){const reason=required(input.reason,'a correction reason',1000);row.corrections ||= [];row.corrections.push({at:new Date().toISOString(),by:user.name,reason,before:{discussion:row.discussion,recommendations:row.recommendations,managementResponse:row.managementResponse,attendees:clone(row.attendees),acknowledgments:clone(row.acknowledgments)}});row.acknowledgments=[];}
        Object.assign(row,{discussion,recommendations,managementResponse,attendees:row.invited.filter(person=>attendeeIds.includes(person.memberId)),status:'completed',recordedAt:new Date().toISOString(),recordedBy:user.name});row.actions.push(...actions);
        audit(row,user,route[3]==='amend'?'Meeting corrected; prior record preserved':'Meeting recorded');writeDb(db);return reply(200,projectedMeeting(row,user));
      }
      return reply(405,{error:'Method not supported'});
    } catch(error) { if(error.statusCode)return reply(error.statusCode,{error:error.message});throw error; }
  };
}
module.exports={RULE,starterTopics,platformTopics,saveTopic,dates,meetingVisible,createSafetyProgramHandler};
