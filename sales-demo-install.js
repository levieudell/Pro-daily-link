'use strict';
// Pure preparation only. Persistence must run inside the authorized tenant write
// queue with its normal revision and backup controls; this module performs no I/O.
const {buildSalesDemo}=require('./sales-demo-data');
const NAME='DEMO | Alder Ridge Builders';
function prepareEmptyDemoTenant(target,{expectedCompanyId,asOf='2026-10-05'}={}) {
 if(!target?.company||!expectedCompanyId||target.company.id!==expectedCompanyId)throw new Error('Confirm the exact new demo company ID');
 if(target.company.name!==NAME)throw new Error(`Only a separately created company named ${NAME} may be prepared`);
 if(target.company.demoFixture)throw new Error('This demo has already been seeded; reset is a separate, destructive operation');
 for(const [key,value] of Object.entries(target.company))if(/stripe|founder|subscriptionId|payment|billingCustomer/i.test(key)&&value)throw new Error('A company with payment or subscription links cannot be converted to a demo');
 if(!Array.isArray(target.users)||target.users.length!==1||target.users[0].role!=='owner'||target.users[0].status!=='Active'||target.users[0].companyId!==expectedCompanyId)throw new Error('A single existing active company owner is required; no accounts will be created');
 if(target.users[0].memberId||(target.users[0].projectIds||[]).length)throw new Error('The demo owner must not already be linked to operating records');
 for(const [key,value] of Object.entries(target))if(Array.isArray(value)&&!['users','sessions'].includes(key)&&value.length)throw new Error(`The demo must be empty: ${key} contains records`);
 if(target.company.features?.timeCards===false)throw new Error('Enable time cards for the new demo company before preparing it');
 if(target.company.logo)throw new Error('The demo must not contain a real company logo');
 const seed=buildSalesDemo({companyId:expectedCompanyId,asOf});
 return {...structuredClone(target),...seed,company:{...structuredClone(target.company),...seed.company,createdAt:target.company.createdAt||seed.company.createdAt,...(target.company.persistence?{persistence:structuredClone(target.company.persistence)}:{})},users:structuredClone(target.users),sessions:structuredClone(target.sessions||[])};
}
module.exports={prepareEmptyDemoTenant};
