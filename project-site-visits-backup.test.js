'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateTenantSnapshot, collectStorageReferences } = require('./database/portable-backup');

const companyId = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  company: { id: companyId, name: 'QA Site Visit Tenant' },
  users: [{ id: 1, name: 'Owner', email: 'owner@example.invalid', role: 'owner', status: 'Active' }],
  projects: [{ id: 101, name: 'QA Project' }],
  photos: [{ id: 501, projectId: 101, siteVisitId: '10000000-0000-4000-8000-000000000001', storageBucket: 'project-photos', storageKey: `${companyId}/site.jpg` }],
  projectSiteVisits: [{
    id: '10000000-0000-4000-8000-000000000001', companyId, projectId: 101, status: 'completed', revision: 4,
    entries: [{ id: '20000000-0000-4000-8000-000000000001', type: 'photo', photoIds: [501] }]
  }],
  safetyDays: [{ id: 'safety-1', companyId, projectId: 101 }]
};

assert.doesNotThrow(() => validateTenantSnapshot(snapshot), 'site visits and safety records are portable tenant collections');
assert.deepEqual(collectStorageReferences(snapshot), [{ bucket: 'project-photos', objectKey: `${companyId}/site.jpg`, source: 'photos:501' }]);

for (const [name, mutate, message] of [
  ['cross-tenant visit', copy => { copy.projectSiteVisits[0].companyId = '22222222-2222-4222-8222-222222222222'; }, /different company/],
  ['dangling project', copy => { copy.projectSiteVisits[0].projectId = 999; }, /missing project/],
  ['dangling user', copy => { copy.projectSiteVisits[0].startedByUserId = 999; }, /missing user/],
  ['dangling photo', copy => { copy.projectSiteVisits[0].entries[0].photoIds = [999]; }, /missing photo/],
  ['cross-visit photo', copy => { copy.photos[0].siteVisitId = '30000000-0000-4000-8000-000000000001'; }, /another project or visit|missing or different site visit/]
]) {
  const copy = structuredClone(snapshot); mutate(copy);
  assert.throws(() => validateTenantSnapshot(copy), message, name);
}

const reconciliation = fs.readFileSync('database/shadow-reconciliation.js', 'utf8');
assert.match(reconciliation, /projectSiteVisits/);
assert.match(reconciliation, /safetyDays/);

console.log('project-site-visits backup contracts passed');

