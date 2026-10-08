'use strict';
const crypto = require('node:crypto');
// Tenant ID matches the authorized pilot; every record and session remains synthetic.
const companyA = '21c12cd3-4822-4b1e-94e8-beca44efc0b7', companyB = '22222222-2222-4222-8222-222222222222';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = (company, user) => `synthetic-assistant-${company}-${user}`;
function fixture(companyId = companyA) {
  const db = { company: { id: companyId, name: 'Synthetic Assistant Company', demo: true, timezone: 'America/Los_Angeles', features: {} },
    projects: [{ id: 101, name: 'Synthetic site A', status: 'Active', customerId: 1, estimateItems: [] }, { id: 102, name: 'Private synthetic site', status: 'Active', customerId: 2, estimateItems: [] }],
    team: [{ id: 11, name: 'Jordan Sample', crew: 'A', role: 'Crew member' }, { id: 12, name: 'Jordan Sample', crew: 'A', role: 'Crew member' }, { id: 13, name: 'Private member', crew: 'B', role: 'Crew member' }],
    customers: [], assignments: [], workdays: [], reports: [], photos: [], changes: [], catalog: [], subcontractors: [], subcontractorLinks: [], timeOffRequests: [], users: [], sessions: [] };
  db.users = [{ id: 1, role: 'owner' }, { id: 2, role: 'project_manager', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true } }, { id: 3, role: 'project_manager', projectIds: [102], assignedCrews: ['B'], permissions: { scheduleCrews: true } }, { id: 4, role: 'field', memberId: 11 }, { id: 5, role: 'foreman', memberId: 11 }, { id: 6, role: 'project_manager', projectIds: [101], assignedCrews: ['A'], permissions: {} }, { id: 7, role: 'admin' }]
    .map(user => ({ ...user, companyId, name: 'Synthetic user ' + user.id, email: `user${user.id}@example.invalid`, status: 'Active' }));
  db.sessions = db.users.map(user => ({ userId: user.id, companyId, tokenHash: hash(token(companyId, user.id)), expiresAt: '2099-01-01T00:00:00Z' }));
  return db;
}
module.exports = { companyA, companyB, fixture, token };
