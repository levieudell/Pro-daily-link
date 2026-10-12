'use strict';
const { A, initial, credential, snapshot } = require('./compat-account-fixture');
function workspaceSnapshot() {
  const db = snapshot(), verified = new Date().toISOString(); db.company.features = { timeCards: true, templates: true }; db.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] }; db.company.emailVerificationRequiredAt = null;
  db.users[0].emailVerifiedAt = verified;
  db.projects[0].estimateItems = [{ id: 1, name: 'Synthetic wall tile', unit: 'SF', plannedQuantity: 100, budgetHours: 10, cost: 500 }]; db.projects[0].site = 'Synthetic Site'; db.projects[0].crew = 'Synthetic Crew'; db.projects[0].color = 'green'; db.projects[0].customerId = 21;
  db.team.push({ id: 12, name: 'Synthetic Field', crew: 'Synthetic Crew', role: 'Foreman', email: 'field@example.invalid', hours: 0, initials: 'SF', site: 'Synthetic Site' });
  db.users.push({ id: 2, companyId: A, memberId: 12, name: 'Synthetic Field', email: 'field@example.invalid', emailVerifiedAt: verified, status: 'Active', role: 'field', ...credential(initial), projectIds: [], assignedCrews: [], permissions: {} });
  db.assignments.push({ id: 1, projectId: 101, memberIds: [12], crew: 'Synthetic Crew', date: new Date().toISOString().slice(0, 10), start: '08:00', end: '16:00', activity: 'Synthetic tile', acknowledgements: {}, notifications: {} });
  db.reports.push({ id: 1, project: 0, dateIso: '2026-10-01', date: 'Oct 1', foreman: 'Synthetic Field', sourceAssignmentId: null, crew: 'Synthetic Crew', status: 'Approved', notes: 'Synthetic completed work', summary: 'Synthetic completed tile', labor: '2 hours', quantity: '10 SF', issue: '', next: '', weather: 'Clear', temperature: '70', materials: '', equipment: '', delays: '', safety: '', signature: 'Synthetic Field', productionEntries: [{ estimateItemId: 1, description: 'Synthetic wall tile', quantity: 10, unit: 'SF', laborHours: 2 }], laborEntries: [{ memberId: 12, hours: 2, crew: 'Synthetic Crew' }], flags: [], history: [] });
  return db;
}
module.exports = { workspaceSnapshot };
