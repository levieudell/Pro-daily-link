'use strict';
const { fixture } = require('./project-assistant');
function workspace() {
  const db = fixture(); db.company.features.timeCards = true;
  db.users[1].permissions = { scheduleCrews: true, manageTime: true, viewTime: true, viewDailies: true, approveDailies: true };
  db.customers = [{ id: 1, name: 'Synthetic allowed customer', billingEmail: 'PRIVATE-CUSTOMER' }, { id: 2, name: 'Synthetic restricted customer', phone: 'PRIVATE-PHONE' }];
  db.projects[0].budget = 'PRIVATE-BUDGET'; db.team[2].rate = 'PRIVATE-RATE';
  db.assignments = [{ id: 9001, projectId: 101, memberIds: [11, 13], date: '2098-10-12', start: '08:00', end: '16:00', instructions: 'PRIVATE-INSTRUCTIONS' }];
  db.reports = [{ id: 9101, project: 1, foreman: db.team[0].name, laborEntries: [{ memberId: 12, hours: 1 }], notes: 'PRIVATE-NARRATIVE' }];
  db.timeCards = [{ id: 9201, memberId: 13, projectId: 102, status: 'submitted', hours: 7, history: [] }];
  return db;
}
module.exports = { workspace };
