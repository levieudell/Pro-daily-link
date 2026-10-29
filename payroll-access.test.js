'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { can, grants, withPayrollGrant, migratePermissionGrants } = require('./payroll-access');

test('owner can use payroll with an empty grant list', () => {
  assert.equal(can({ role: 'owner', permissionGrants: [] }, 'payroll'), true);
  assert.equal(can({ role: 'owner' }, 'payroll'), true);
});

test('office payroll access is the permissionGrants array', () => {
  assert.equal(can({ role: 'admin', permissionGrants: [] }, 'payroll'), false);
  assert.equal(can({ role: 'admin', permissionGrants: ['payroll'] }, 'payroll'), true);
  assert.equal(can({ role: 'project_manager', permissionGrants: ['payroll'] }, 'payroll'), true);
  assert.deepEqual(withPayrollGrant({ permissionGrants: [] }, true), ['payroll']);
  assert.deepEqual(withPayrollGrant({ permissionGrants: ['payroll'] }, false), []);
});

test('field and foreman never pass can(payroll)', () => {
  assert.equal(can({ role: 'field', permissionGrants: ['payroll'] }, 'payroll'), false);
  assert.equal(can({ role: 'foreman', permissionGrants: ['payroll'] }, 'payroll'), false);
  assert.equal(can(null, 'payroll'), false);
});

test('migration defaults a missing grant list to empty and leaves payroll off', () => {
  const db = { users: [{ id: 1, role: 'admin' }, { id: 2, role: 'owner', permissionGrants: ['payroll'] }] };
  assert.equal(migratePermissionGrants(db), true);
  assert.deepEqual(db.users[0].permissionGrants, []);
  assert.equal(can(db.users[0], 'payroll'), false);
  assert.equal(can(db.users[1], 'payroll'), true);
  assert.equal(migratePermissionGrants(db), false);
  assert.deepEqual(grants(db.users[0]), []);
});
