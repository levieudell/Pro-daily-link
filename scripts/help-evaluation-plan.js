'use strict';
// Preparation only. This script has no provider call or API-key access.
const {LIMITS,payloadFor}=require('../help-conversation'),{buildRequest}=require('../help-answer-draft'),cases=require('../fixtures/help-evaluation.json');
const assert=require('node:assert/strict');
assert.equal(cases.length,20);assert.equal(cases.reduce((n,c)=>n+c.turns.length,0),60);
for(const row of cases)for(const text of row.turns)payloadFor(buildRequest({role:row.role,text}),row.role);
console.log(JSON.stringify({provider:'OpenAI Responses API',...LIMITS,maximumCalls:60,maximumReservedUsd:60*LIMITS.perCallMicros/1000000,costCeilingUsd:1,perUserDailyUsd:LIMITS.userDailyCalls*LIMITS.perCallMicros/1000000,perTenantDailyUsd:LIMITS.tenantDailyCalls*LIMITS.perCallMicros/1000000,data:['role enum','role-filtered verified product passages','current synthetic question','up to six bounded conversation turns'],excludes:['account records','company/user IDs','email','project/team names','reports/files','billing','credentials','tools'],acceptance:'20 conversations x 3 turns. Record actual output, source faithfulness, follow-up quality, latency and measured usage. Human scoring required; this script proves preparation only.',approved:false,providerCalls:0},null,2));
