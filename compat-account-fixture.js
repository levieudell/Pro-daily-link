'use strict';
// Explicit synthetic identities/data; never clone a workspace or production file.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { COLLECTION } = require('./account-credential-delivery');
const A = 'b0576860-a3d9-4bb6-aae2-b5e7186cbb71', B = 'ba19a156-1cac-4c8a-b921-6bc356df97ef';
const initial = 'Synthetic original pass 2026';
function credential(value) { const salt = crypto.randomBytes(16).toString('hex'); return { passwordSalt: salt, passwordHash: crypto.scryptSync(value, salt, 64).toString('hex') }; }
function snapshot() {
  return { company: { id: A, name: 'Synthetic Construction', timezone: 'UTC', plan: 'growth', billingExempt: true, features: { timeCards: true, templates: true } },
    users: [{ id: 1, companyId: A, memberId: 11, name: 'Synthetic Owner', email: 'owner@example.invalid', status: 'Active', role: 'owner', ...credential(initial), projectIds: [], assignedCrews: [], permissions: {} }],
    team: [{ id: 11, name: 'Synthetic Owner', crew: 'Synthetic Crew', initials: 'SO', role: 'Account Owner', hours: 0, userId: 1, email: 'owner@example.invalid' }],
    projects: [{ id: 101, name: 'Synthetic Project', code: 'SYN', status: 'Active', customer: 0, estimateItems: [], templateId: 'standard' }],
    customers: [{ id: 21, name: 'Synthetic Customer' }], sessions: [], reports: [], photos: [], assignments: [], workdays: [], timeCards: [],
    auditLog: [], timeOffRequests: [], changes: [], payPeriods: [], payPeriodExports: [], reportingExports: [], projectTickets: [], subcontractors: [],
    subcontractorLinks: [], catalog: [], activityCodes: [], dailyTemplates: [], projectNotesTodos: [], assignmentEmailOutbox: [], [COLLECTION]: [] };
}
function memory(seed) {
  let db = structuredClone(seed), revision = 0;
  const api = { beforeCommit: null, beforeLoad: null, rejectCommit: false, loseCommitAck: false,
    async load(id) { if (id !== A) throw Error('Synthetic tenant mismatch'); if (api.beforeLoad) await api.beforeLoad(); return { snapshot: structuredClone(db), revision, contentHash: canonicalHash(db) }; },
    async commit(candidate, expected, guard) {
      if (api.beforeCommit) await api.beforeCommit(candidate, expected);
      if (api.rejectCommit || expected !== revision || guard && Date.parse(guard.deadline) <= Date.now()) throw Object.assign(Error('Synthetic CAS rejection'), { code: 'PDL_REVISION_CONFLICT' });
      db = structuredClone(candidate); revision++; const result = { revision, contentHash: canonicalHash(db) };
      if (api.loseCommitAck) { api.loseCommitAck = false; throw Object.assign(Error('Synthetic unknown commit result'), { statusCode: 503, code: 'PDL_COMMIT_OUTCOME_UNKNOWN' }); }
      return result;
    }, current() { return structuredClone(db); }, revision() { return revision; }
  }; return api;
}
module.exports = { A, B, initial, credential, snapshot, memory };
