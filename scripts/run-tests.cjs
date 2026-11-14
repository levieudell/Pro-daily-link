'use strict';
const {spawnSync}=require('node:child_process');
const preload=require.resolve('./test-analytics-isolation.cjs');
// NODE_OPTIONS is scoped to this test subprocess and inherited by test servers.
const env={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--require=${JSON.stringify(preload)}`].filter(Boolean).join(' ')};
for(const test of ['debrief-access.test.js','report-day-flags-api.test.js','report-day-flags.browser.test.js']){
  const result=spawnSync(process.execPath,[test],{stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;return;}
}
const result=spawnSync(process.execPath,[process.env.npm_execpath,'run','test:app'],{stdio:'inherit',env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
