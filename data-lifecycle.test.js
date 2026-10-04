const assert=require('node:assert/strict');
const {customerDataExport}=require('./server');

const exported=customerDataExport({
  company:{id:'company-test',name:'Test Company',stripeCustomerId:'cus_secret'},
  users:[{id:1,email:'owner@example.test',passwordHash:'hash',passwordSalt:'salt',setupHash:'setup',setupSalt:'setup-salt'}],
  subcontractorLinks:[{id:1,tokenHash:'token-secret'}],
  sessions:[{tokenHash:'session-secret'}],
  passwordResets:[{tokenHash:'reset-secret'}],
  projects:[{id:1,name:'Project One'}]
});

assert.equal(exported.company.stripeCustomerId,undefined);
assert.equal(exported.users[0].passwordHash,undefined);
assert.equal(exported.users[0].passwordSalt,undefined);
assert.equal(exported.users[0].setupHash,undefined);
assert.equal(exported.subcontractorLinks[0].tokenHash,undefined);
assert.equal(exported.sessions,undefined);
assert.equal(exported.passwordResets,undefined);
assert.equal(exported.projects[0].name,'Project One');
assert.equal(exported.exportMetadata.companyId,'company-test');
assert.equal(exported.exportMetadata.version,1);
console.log('Data lifecycle export tests passed');
