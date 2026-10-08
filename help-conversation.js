'use strict';
const crypto=require('node:crypto');
const {buildRequest,validateAnswer}=require('./help-answer-draft');
const MODEL='gpt-5.4-mini-2026-03-17',MAX_INPUT=16000,MAX_OUTPUT=800,RESERVE_MICROS=15600;
const LIMITS=Object.freeze({model:MODEL,inputTokens:MAX_INPUT,outputTokens:MAX_OUTPUT,perCallMicros:RESERVE_MICROS,userDailyCalls:20,tenantDailyCalls:60,evaluationCalls:60,evaluationMicros:1000000});
const schema={type:'object',additionalProperties:false,properties:{answer:{type:'string'},sourceIds:{type:'array',items:{type:'string'}},clarification:{type:['string','null']},escalate:{type:'boolean'}},required:['answer','sourceIds','clarification','escalate']};
function payloadFor(request,role){
  const payload={model:MODEL,store:false,service_tier:'default',reasoning:{effort:'low'},max_output_tokens:MAX_OUTPUT,instructions:request.instructions,input:JSON.stringify({role,knowledge:request.knowledge,conversation:request.conversation}),text:{format:{type:'json_schema',name:'pdl_help',strict:true,schema}}};
  // UTF-8 bytes conservatively bound tokenizer input; reserve extra for framing/schema.
  if(Buffer.byteLength(JSON.stringify(payload))>12000)throw Error('Shorten this conversation or start a new one.');
  return payload;
}
async function openAIHelp(payload,signal,fetchImpl=fetch){
  // A code/configuration gate, not approval by implication. Never set during draft QA.
  if(process.env.PDL_HELP_AI_APPROVED!=='synthetic-evaluation-v1'||!process.env.OPENAI_API_KEY)throw Error('AI Help provider is disabled.');
  const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify(payload)});
  if(!response.ok)throw Error('Help provider unavailable');
  const data=await response.json();
  if(data.status!=='completed')throw Error('Help response incomplete');
  const parts=(data.output||[]).flatMap(row=>row.content||[]);
  if(parts.some(row=>row.type==='refusal'))throw Error('Help response unavailable');
  const raw=data.output_text||parts.filter(row=>row.type==='output_text').map(row=>row.text).join('');
  if(typeof raw!=='string'||raw.length>6000)throw Error('Invalid help response');
  return {answer:JSON.parse(raw),usage:data.usage};
}
const roles=new Set(['owner','admin','project_manager','foreman','field']);
function actorOf(db,user){return crypto.createHash('sha256').update(JSON.stringify([db.company.id,user.id,user.role,user.status])).digest('hex')}
function createHelpConversation({readDb,readFreshDb=async()=>readDb(),persist,authenticatedUser,accountAccess,adapter=null,enabled=()=>false,now=()=>new Date(),timeoutMs=15000}){
  const key=crypto.randomBytes(32),cache=new Map();
  function seal(state){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url')}
  function unseal(token,actor){try{if(typeof token!=='string'||token.length>24000)throw Error();const bytes=Buffer.from(token,'base64url'),decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));const state=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());if(state.actor!==actor||state.expiresAt<+now())throw Error();return state}catch{throw Error('Conversation expired or account changed. Start a new conversation.')}}
  async function turn(req,input){
    if(!enabled()||!adapter)throw Object.assign(Error('Conversational Help is disabled pending review.'),{statusCode:503});
    const db=readDb(),user=authenticatedUser(req,db);
    if(!user||!roles.has(user.role)||user.status!=='Active'||user.companyId!=null&&user.companyId!==db.company.id||accountAccess(db.company).locked)throw Object.assign(Error('Help access unavailable.'),{statusCode:403});
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['text','state','turnId','consent'].includes(k))||input.consent!==true||!/^\w{8}-\w{4}-4\w{3}-[89ab]\w{3}-\w{12}$/i.test(input.turnId||'')||typeof input.text!=='string')throw Object.assign(Error('Send a bounded question with explicit AI data consent.'),{statusCode:400});
    const actor=actorOf(db,user),state=input.state?unseal(input.state,actor):{actor,history:[],expiresAt:+now()+30*60000};
    const request=buildRequest({role:user.role,text:input.text,history:state.history});
    // Common obvious private identifiers are rejected, not silently sent. This is not a comprehensive PII detector.
    if(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b|(?:bearer|api[_ -]?key|password)\s*[:=]|\bsk-[a-z0-9_-]{8,}/i.test(input.text))throw Object.assign(Error('Remove contact details and credentials. Ask a general product question.'),{statusCode:400});
    const payload=payloadFor(request,user.role),fingerprint=crypto.createHash('sha256').update(JSON.stringify([actor,input.text,input.state||''])).digest('hex');
    db.helpAIReceipts ||= [];
    const previous=db.helpAIReceipts.find(row=>row.userId===user.id&&row.turnId===input.turnId);
    if(previous){if(previous.fingerprint!==fingerprint)throw Object.assign(Error('This turn identifier was already used.'),{statusCode:409});const cached=cache.get(`${actor}:${input.turnId}`);if(cached&&cached.expiresAt>+now())return cached.result;throw Object.assign(Error('This turn was already attempted; no duplicate provider request was made.'),{statusCode:409})}
    const day=now().toISOString().slice(0,10),daily=db.helpAIReceipts.filter(row=>row.day===day),mine=daily.filter(row=>row.userId===user.id),all=db.helpAIReceipts.filter(row=>row.scope==='synthetic-evaluation-v1');
    if(mine.length>=LIMITS.userDailyCalls||daily.length>=LIMITS.tenantDailyCalls||all.length>=LIMITS.evaluationCalls||all.reduce((sum,row)=>sum+row.reservedMicros,0)+RESERVE_MICROS>LIMITS.evaluationMicros)throw Object.assign(Error('Help usage cap reached. Published help and Support remain available.'),{statusCode:429});
    const receipt={userId:user.id,turnId:input.turnId,fingerprint,day,scope:'synthetic-evaluation-v1',reservedMicros:RESERVE_MICROS,status:'reserved',at:now().toISOString()};db.helpAIReceipts.push(receipt);
    // Must durably reserve before the provider; caller holds tenant queue. Failed/unknown calls keep full reservation.
    await persist(db);
    let timer;const controller=new AbortController();
    try{
      const result=await Promise.race([adapter(payload,controller.signal),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Help provider timed out'))},timeoutMs)})]);
      const fresh=await readFreshDb(req),active=authenticatedUser(req,fresh);
      if(!active||actorOf(fresh,active)!==actor||accountAccess(fresh.company).locked)throw Error('Help account changed');
      const answer=validateAnswer(request,result.answer);
      if(!answer.sourceIds.length&&!answer.clarification&&!answer.escalate)throw Error('Answer lacks grounding');
      const usage=result.usage;
      if(!Number.isSafeInteger(usage?.input_tokens)||!Number.isSafeInteger(usage?.output_tokens)||usage.input_tokens<0||usage.input_tokens>MAX_INPUT||usage.output_tokens<0||usage.output_tokens>MAX_OUTPUT)throw Error('Help usage receipt missing or outside approved bounds');
      const response={...answer,state:seal({...state,history:[...state.history,{role:'user',content:input.text},{role:'assistant',content:(answer.answer+(answer.clarification?'\n'+answer.clarification:'')).slice(0,2000)}].slice(-6)}),source:'ai',deliveryEnabled:false};
      receipt.status='complete';receipt.actualMicros=Math.ceil(usage.input_tokens*.75+usage.output_tokens*4.5);await persist(db);
      cache.set(`${actor}:${input.turnId}`,{expiresAt:state.expiresAt,result:response});for(const [id,value] of cache)if(value.expiresAt<+now())cache.delete(id);while(cache.size>500)cache.delete(cache.keys().next().value);
      return response;
    }catch{receipt.status='unknown';await persist(db);throw Object.assign(Error('I could not verify an answer. Try published help or contact Support. No account action was taken.'),{statusCode:502})}finally{clearTimeout(timer);controller.abort()}
  }
  return {turn,limits:LIMITS};
}
module.exports={LIMITS,MODEL,payloadFor,openAIHelp,createHelpConversation};
