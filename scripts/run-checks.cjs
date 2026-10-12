'use strict';
// Avoid shell command-length limits while retaining the exact check inventory.
const {spawnSync}=require('node:child_process'),path=require('node:path');
const manifest=require('./check-manifest.json'),kind=process.argv[2];
if(!['check','test'].includes(kind))throw Error('Choose check or test');
for(const command of manifest[kind]){
 const parts=command.split(' ');if(parts[0]!=='node'||parts.some(value=>!value||/[;&|"'`]/.test(value)))throw Error('Invalid check inventory command');
 const result=spawnSync(process.execPath,parts.slice(1),{cwd:path.resolve(__dirname,'..'),stdio:'inherit',shell:false});
 if(result.error)throw result.error;if(result.status!==0){process.exitCode=result.status||1;break;}
}
