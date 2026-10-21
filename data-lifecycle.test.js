const assert=require('node:assert/strict');
const {customerDataExport}=require('./server');

const exported=customerDataExport({
  company:{id:'company-test',name:'Test Company',phone:'503-555-0100',pricingAccess:{enabled:true,officeMode:'selected',userIds:[1]},stripeCustomerId:'cus_secret',stripeSubscriptionId:'sub_secret',stripeFreePeriod:{subscriptionId:'sub_secret',end:123},retiredStripeSubscriptionIds:['sub_old'],pendingCheckout:{id:'cs_secret',params:{customer:'cus_secret'}}},
  users:[{id:1,name:'Owner Person',email:'owner@example.test',phone:'503-555-0101',passwordHash:'hash',passwordSalt:'salt',setupHash:'setup',setupSalt:'setup-salt',resetTokenHash:'reset-user-secret',resetExpiresAt:'2099-01-01T00:00:00.000Z',emailVerificationTokenHash:'verify-secret',emailVerificationExpiresAt:'2099-01-01T00:00:00.000Z'}],
  subcontractorLinks:[{id:1,tokenHash:'token-secret'}],
  changes:[{id:1,title:'Safe change',customerTokenHash:'customer-secret'}],
  sessions:[{tokenHash:'session-secret'}],
  passwordResets:[{tokenHash:'reset-secret'}],
  oauthClients:[{id:1,name:'Private client',clientSecretHash:'oauth-secret'}],
  projects:[{id:1,name:'Project One',sourceHash:'non-credential-evidence-hash'}]
});

assert.equal(exported.company.stripeCustomerId,undefined);
assert.equal(exported.company.stripeSubscriptionId,undefined);
assert.equal(exported.company.stripeFreePeriod,undefined);
assert.equal(exported.company.retiredStripeSubscriptionIds,undefined);
assert.equal(exported.company.pendingCheckout,undefined);
assert.deepEqual(exported.company.pricingAccess,{enabled:true,officeMode:'selected',userIds:[1]},'legitimate pricing visibility settings survive the owner portability export');
assert.equal(exported.company.phone,'503-555-0100','customer-owned business contact data remains portable');
assert.equal(exported.users[0].name,'Owner Person');
assert.equal(exported.users[0].email,'owner@example.test');
assert.equal(exported.users[0].phone,'503-555-0101');
assert.equal(exported.users[0].passwordHash,undefined);
assert.equal(exported.users[0].passwordSalt,undefined);
assert.equal(exported.users[0].setupHash,undefined);
assert.equal(exported.users[0].resetTokenHash,undefined);
assert.equal(exported.users[0].resetExpiresAt,undefined);
assert.equal(exported.users[0].emailVerificationTokenHash,undefined);
assert.equal(exported.users[0].emailVerificationExpiresAt,undefined);
assert.equal(exported.subcontractorLinks[0].tokenHash,undefined);
assert.equal(exported.changes[0].customerTokenHash,undefined);
assert.equal(exported.oauthClients[0].clientSecretHash,undefined);
assert.equal(exported.sessions,undefined);
assert.equal(exported.passwordResets,undefined);
assert.equal(exported.projects[0].name,'Project One');
assert.equal(exported.projects[0].sourceHash,'non-credential-evidence-hash');
assert.equal(exported.exportMetadata.companyId,'company-test');
assert.equal(exported.exportMetadata.version,1);
console.log('Data lifecycle export tests passed');
