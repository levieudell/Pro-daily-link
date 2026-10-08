'use strict';
const fs=require('node:fs'),cases=require('../fixtures/help-evaluation.json'),{LIMITS}=require('../help-conversation');
const {KNOWLEDGE}=require('../help-answer-draft');
const dimensions=['grounding','roleNavigation','context','clarificationUnknowns','usefulness','communication'];
function template(){return {model:LIMITS.model,commit:null,approvedScope:'60-attempt-$1-synthetic-only',primaryReviewer:null,independentReviewer:null,reviewResolved:false,turns:cases.flatMap((c,index)=>c.turns.map((question,turn)=>({case:index+1,turn:turn+1,role:c.role,question,expected:c.expect,answer:null,sourceIds:[],clarification:null,escalate:false,status:null,inputTokens:null,outputTokens:null,latencyMs:null,criticalFailure:null,scores:Object.fromEntries(dimensions.map(d=>[d,null]))})))}}
function score(sheet){
  if(sheet.model!==LIMITS.model||!/^([a-f0-9]{40})$/.test(sheet.commit||'')||sheet.approvedScope!=='60-attempt-$1-synthetic-only'||!sheet.primaryReviewer||!sheet.independentReviewer||sheet.primaryReviewer===sheet.independentReviewer||sheet.reviewResolved!==true||!Array.isArray(sheet.turns)||sheet.turns.length!==60)throw Error('Incomplete exact-scope evaluation and independent review');
  const seen=new Set(),complete=Object.fromEntries(dimensions.map(d=>[d,0]));let followups=0,critical=0,cost=0,costUpperBound=0,unknownUsage=0;const latencies=[];
  for(const row of sheet.turns){const expected=cases[row.case-1],id=row.case+':'+row.turn;if(!Number.isSafeInteger(row.case)||!Number.isSafeInteger(row.turn)||!expected||row.turn<1||row.turn>3||seen.has(id)||row.role!==expected.role||row.question!==expected.turns[row.turn-1])throw Error('Missing, duplicate or altered prepared turn');seen.add(id);
    const knownUsage=[row.inputTokens,row.outputTokens].every(v=>Number.isSafeInteger(v)&&v>=0),failed=row.status!=='completed';
    if(typeof row.answer!=='string'||!['completed','error','timeout','refusal','invalid-response'].includes(row.status)||!dimensions.every(d=>[0,1,2].includes(row.scores?.[d]))||!Number.isFinite(row.latencyMs)||row.latencyMs<0||!knownUsage&&!(failed&&row.inputTokens===null&&row.outputTokens===null))throw Error('Unscored answer or missing usage/latency');
    const allowed=KNOWLEDGE.filter(k=>k.roles.includes(row.role)).map(k=>k.id);
    if(!Array.isArray(row.sourceIds)||row.sourceIds.some(id=>!allowed.includes(id))||typeof row.escalate!=='boolean'||!(row.clarification===null||typeof row.clarification==='string'))throw Error('Missing or invalid role-scoped response evidence');
    if(!failed&&(!row.answer.trim()||!row.sourceIds.length&&!row.clarification?.trim()&&!row.escalate))throw Error('Missing completed answer or grounding/clarification/escalation evidence');
    for(const d of dimensions)if(row.scores[d]===2)complete[d]++;
    if(row.turn>1&&row.scores.context===2)followups++;
    if(row.criticalFailure||row.status!=='completed'||row.inputTokens>LIMITS.inputTokens||row.outputTokens>LIMITS.outputTokens)critical++;
    if(knownUsage){const micros=row.inputTokens*.75+row.outputTokens*4.5;cost+=micros;costUpperBound+=micros}else{unknownUsage++;costUpperBound+=LIMITS.perCallMicros}latencies.push(row.latencyMs);
  }
  latencies.sort((a,b)=>a-b);const p95=latencies[Math.ceil(latencies.length*.95)-1],passed=!critical&&complete.grounding===60&&complete.roleNavigation===60&&complete.usefulness>=54&&complete.communication>=54&&complete.clarificationUnknowns>=54&&followups>=36&&p95<=10000&&latencies.at(-1)<=15000&&costUpperBound<=1000000;
  return {passed,attempts:60,criticalFailures:critical,complete,correctFollowups:followups,p95Ms:p95,knownMeasuredUsd:cost/1000000,unknownUsageAttempts:unknownUsage,costUpperBoundUsd:costUpperBound/1000000,maximumReservedUsd:60*LIMITS.perCallMicros/1000000,semanticJudgment:'Reviewer-entered; independent source verification required',providerCallsByScorer:0};
}
if(require.main===module){try{const [mode,file]=process.argv.slice(2);if(!file||!['--template','--score'].includes(mode))throw Error('Use --template <path> or --score <path>');if(mode==='--template'){fs.writeFileSync(file,JSON.stringify(template(),null,2));console.log('Prepared 60 unscored rows. No provider called.')}else{const result=score(JSON.parse(fs.readFileSync(file)));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1}}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={template,score};
