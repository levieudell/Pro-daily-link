'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const url=process.env.TEST_ROLES_DATABASE_URL;
if(!url||!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/pdl_roles_production_synthetic_[a-z0-9_]+$/.test(url))throw Error('Explicit fresh owned synthetic database required');
const A='a0527b09-7132-4e31-84f8-41ff6512a41b';let checks=0;
const connect=async()=>{const c=new Client({connectionString:url});await c.connect();return c;};
async function main(){
 const c=await connect();try{
  await c.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;CREATE TABLE companies(id uuid PRIMARY KEY,name text,data jsonb NOT NULL);CREATE TABLE tenant_records(company_id uuid,data jsonb);CREATE TABLE tenant_revisions(company_id uuid,revision bigint)");
  await c.query(fs.readFileSync(path.join(__dirname,'009_roles_snapshot_authority.sql'),'utf8'));
  const value={company:{id:A,name:'Generated company'}};
  await c.query('INSERT INTO companies(id,name,data) VALUES($1,$2,$3)',[A,'Generated company',value]);await c.query("UPDATE companies SET name='Unmanaged exact default' WHERE id=$1",[A]);checks++;
  await c.query('UPDATE companies SET roles_managed=true WHERE id=$1',[A]);
  async function rejected(sql,values,code){await assert.rejects(c.query(sql,values),error=>error.code===code);checks++;}
  await rejected("UPDATE companies SET name='Legacy overwrite' WHERE id=$1",[A],'23514');
  await rejected('DELETE FROM companies WHERE id=$1',[A],'23514');
  await rejected('INSERT INTO tenant_records VALUES($1,$2)',[A,{}],'23514');
  await c.query('SELECT * FROM commit_roles_snapshot($1,0,$2,clock_timestamp()+interval \'5 seconds\')',[A,value]);checks++;
  const one=await connect(),two=await connect();try{const results=await Promise.allSettled([one,two].map(client=>client.query('SELECT * FROM commit_roles_snapshot($1,1,$2,clock_timestamp()+interval \'5 seconds\')',[A,value])));assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.code,'40001');checks+=2;}finally{await one.end();await two.end();}
  await c.query('BEGIN');await c.query('SELECT * FROM commit_roles_snapshot($1,2,$2,clock_timestamp()+interval \'80 milliseconds\')',[A,value]);await c.query('SELECT pg_sleep(0.12)');await rejected('COMMIT',[],'40001');
  assert.equal(Number((await c.query('SELECT roles_revision FROM companies WHERE id=$1',[A])).rows[0].roles_revision),2);checks++;
  await c.query('ALTER TABLE companies DISABLE TRIGGER roles_snapshot_deadline');await rejected('SELECT * FROM commit_roles_snapshot($1,2,$2,clock_timestamp()+interval \'5 seconds\')',[A,value],'23514');await c.query('ALTER TABLE companies ENABLE TRIGGER roles_snapshot_deadline');
  await c.query('ALTER TABLE companies DISABLE TRIGGER roles_snapshot_writer');await rejected('SELECT * FROM commit_roles_snapshot($1,2,$2,clock_timestamp()+interval \'5 seconds\')',[A,value],'23514');await c.query('ALTER TABLE companies ENABLE TRIGGER roles_snapshot_writer');
  await c.query('SET ROLE anon');await rejected('SELECT * FROM commit_roles_snapshot($1,2,$2,clock_timestamp()+interval \'5 seconds\')',[A,value],'42501');await c.query('RESET ROLE; SET ROLE service_role');await c.query('SELECT * FROM commit_roles_snapshot($1,2,$2,clock_timestamp()+interval \'5 seconds\')',[A,value]);await c.query('RESET ROLE');checks++;
  console.log(JSON.stringify({passed:true,checks,backend:'owned-native-postgresql',sourceMigrationOnly:true,productionChanges:false}));
 }finally{await c.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
