'use strict';
const {spawnSync}=require('node:child_process');
const preload=require.resolve('./test-analytics-isolation.cjs');
// NODE_OPTIONS is scoped to this test subprocess and inherited by test servers.
const env={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--require=${JSON.stringify(preload)}`].filter(Boolean).join(' ')};
const debrief=spawnSync(process.execPath,['debrief-access.test.js'],{stdio:'inherit',env});
if(debrief.error)throw debrief.error;
if(debrief.status!==0){process.exitCode=debrief.status??1;return;}
const result=spawnSync(process.execPath,[process.env.npm_execpath,'run','test:app'],{stdio:'inherit',env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
