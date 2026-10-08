'use strict';
const crypto=require('node:crypto');
function createVerifier({cases,buildRequest,validateAnswer,payloadFor,canonicalHash}){
 function prepared(index,ledger){if(!Number.isSafeInteger(index)||index<1||index>60)throw Error('Invalid index');const ci=Math.floor((index-1)/3),ti=(index-1)%3,row=cases[ci];if(!row||row.turns.length!==3)throw Error('Prepared cases missing');if(index>1&&ledger.receipts[index-1]?.status!=='complete')throw Error('Previous attempt not complete');let history=[];
  for(let j=0;j<ti;j++){const prior=ledger.receipts[ci*3+j+1];if(prior?.status!=='complete')throw Error('Synthetic history unavailable');const evidence=JSON.parse(prior.result),request=buildRequest({role:row.role,text:row.turns[j],history}),answer=validateAnswer(request,evidence.answer);history=[...history,{role:'user',content:row.turns[j]},{role:'assistant',content:(answer.answer+(answer.clarification?'\n'+answer.clarification:'')).slice(0,2000)}].slice(-6);}
  const request=buildRequest({role:row.role,text:row.turns[ti],history});return {request,payload:payloadFor(request,row.role)};
 }
 return {prepared,verifyPayload:(index,payload,ledger)=>canonicalHash(payload)===canonicalHash(prepared(index,ledger).payload)};
}
function createRunner({store,createLedger,config,verifier,validateAnswer,fetchImpl,now=()=>performance.now(),timeoutMs=15000}){
 if(timeoutMs!==15000)throw Error('Pinned timeout required');
 async function execute(credential){const token=crypto.randomBytes(32).toString('hex'),ledger=createLedger(store,{...config,verifyPayload:verifier.verifyPayload});let calls=0,knownActualMicros=0;const start=now();
  const summary=stopped=>({providerCalls:calls,knownMeasuredUsd:knownActualMicros/1e6,stopped,quality:'Unscored; offline primary/independent rubric review required'});
  // No auto-init. A duplicated shell invocation gets a fresh token and cannot acquire.
  try{const claimed=await ledger.claim(token);if(!claimed.acquired)return summary('Already claimed/closed; zero calls from this invocation');if(!credential){await ledger.close(token);return summary('Existing credential unavailable; claim remains consumed');}
   for(let index=1;index<=60;index++){
    if(now()-start>=900000)throw Error('Overall deadline');const snapshot=await store.load(),{request,payload}=verifier.prepared(index,snapshot.ledger),admission=await ledger.admit({token,index,payload});if(!admission.dispatch)throw Error('Attempt already consumed');
    const controller=new AbortController(),began=now();let timer,actualMicros=null,evidence=null,failureCategory='transport',rawEvidence=null,observedUsage=null;calls++;
    try{const data=await Promise.race([(async()=>{const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify(payload)});if(!response.ok)throw Error('Provider unavailable');return response.json()})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();failureCategory='timeout';reject(Error('Timeout'))},Math.max(1,Math.min(15000,900000-(now()-start))))})]);
     failureCategory='schema';if(!data||typeof data!=='object')throw Error();const u=data.usage;if(Number.isSafeInteger(u?.input_tokens)&&Number.isSafeInteger(u?.output_tokens)&&u.input_tokens>=0&&u.output_tokens>=0&&u.input_tokens<=1000000000&&u.output_tokens<=1000000000)observedUsage={inputTokens:u.input_tokens,outputTokens:u.output_tokens};if(Number.isSafeInteger(u?.input_tokens)&&Number.isSafeInteger(u?.output_tokens)&&u.input_tokens>=0&&u.input_tokens<=16000&&u.output_tokens>=0&&u.output_tokens<=800){actualMicros=Math.ceil(u.input_tokens*.75+u.output_tokens*4.5);knownActualMicros+=actualMicros;}
     failureCategory='schema';if(data.output!==undefined&&!Array.isArray(data.output))throw Error();if((data.output||[]).some(r=>!r||r.content!==undefined&&!Array.isArray(r.content)))throw Error();const parts=(data.output||[]).flatMap(r=>r.content||[]),raw=data.output_text||parts.filter(r=>r.type==='output_text').map(r=>r.text).join('');rawEvidence=typeof raw==='string'?raw.slice(0,6000):null;if(data.model!==payload.model){failureCategory='model';throw Error();}if(data.status!=='completed'){failureCategory='incomplete';throw Error();}if(parts.some(r=>r.type==='refusal')){failureCategory='refusal';throw Error();}if(actualMicros===null){failureCategory='usage';throw Error();}failureCategory='schema';if(typeof raw!=='string'||raw.length>6000)throw Error();const answer=validateAnswer(request,JSON.parse(raw));failureCategory='grounding';if(!answer.sourceIds.length&&!answer.clarification&&!answer.escalate)throw Error('Missing grounding');evidence=JSON.stringify({answer,inputTokens:u.input_tokens,outputTokens:u.output_tokens,latencyMs:Math.round(now()-began)});
    }catch{await ledger.settle({token,index,fingerprint:admission.fingerprint,actualMicros:null,result:null,observedActualMicros:actualMicros,failureCategory,latencyMs:Math.round(now()-began),rawResponse:rawEvidence,observedUsage});throw Error('Unknown/unusable provider response');}finally{clearTimeout(timer);controller.abort()}
    const settled=await ledger.settle({token,index,fingerprint:admission.fingerprint,actualMicros,result:evidence});if(settled.status!=='complete')throw Error('Unknown settlement');
   }
   await ledger.close(token);return summary(null);
  }catch{try{await ledger.close(token)}catch{}return summary('Uncertain/incomplete evaluation; no retries or replacement invocation');}
 }
 return {execute};
}
module.exports={createVerifier,createRunner};

