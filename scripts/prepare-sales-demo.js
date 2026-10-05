'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {buildSalesDemo,summarizeSalesDemo}=require('../sales-demo-data');
function arg(name){const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];}
const out=arg('--output');if(!out)throw new Error('Use --output <new directory> [--as-of YYYY-MM-DD] [--company-id UUID]');
const db=buildSalesDemo({asOf:arg('--as-of'),companyId:arg('--company-id')});
const directory=path.resolve(out);fs.mkdirSync(directory,{recursive:false});
const payload=JSON.stringify(db,null,2)+'\n';fs.writeFileSync(path.join(directory,'synthetic-demo.json'),payload,{flag:'wx'});
const summary=summarizeSalesDemo(db);fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
const manifest={format:'pdl-credential-free-sales-demo-v1',live:false,companyId:db.company.id,asOf:db.company.demoAsOf,snapshotSha256:crypto.createHash('sha256').update(payload).digest('hex'),warning:'Fictional data only. No accounts, credentials, payments, emails, invitations or remote writes are created. Do not overwrite an existing tenant with this file.'};
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({directory,...manifest,counts:summary.counts},null,2));
