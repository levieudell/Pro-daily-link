'use strict';
// CI-only generated loopback fixtures. Existing databases are never reset.
const {Client}=require('pg');
async function main(){
 if(process.env.NODE_ENV!=='test')throw Error('Synthetic database setup requires test mode');
 const names=['TEST_PLATFORM_DATABASE_URL','TEST_PLATFORM_HTTP_DATABASE_URL'],targets=names.map(name=>process.env[name]);
 if(targets.some(value=>!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/pdl_platform_authority_synthetic_[a-z0-9_]+$/.test(value||''))||new Set(targets).size!==targets.length)throw Error('Distinct explicitly named generated loopback databases required');
 for(const target of targets){const parsed=new URL(target),database=parsed.pathname.slice(1);if(database.length>63)throw Error('Generated name exceeds PostgreSQL limit');parsed.pathname='/postgres';const client=new Client({connectionString:parsed.toString()});await client.connect();try{await client.query('CREATE DATABASE "'+database+'"');}finally{await client.end();}}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
