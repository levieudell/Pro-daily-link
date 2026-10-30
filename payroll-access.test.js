'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
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

test('fresh state revokes client grants and an export denial closes even an owner page', () => {
  const context = vm.createContext({ currentRole:'office', currentUser:{id:1,role:'admin',permissionGrants:['payroll']}, company:{features:{timeCards:true}} });
  vm.runInContext(fs.readFileSync(require.resolve('./payroll-access'),'utf8'), context);
  const access=context.PDLPermissions;
  assert.equal(access.payrollPageAllowed(),true);
  access.refreshCurrentUser({id:1,permissionGrants:[]});
  assert.equal(access.payrollPageAllowed(),false);
  access.refreshCurrentUser({id:1,permissionGrants:['payroll']});
  assert.equal(access.payrollPageAllowed(),true);
  context.currentUser.role='owner';
  access.denyExport();
  assert.equal(access.payrollPageAllowed(),false);
  access.refreshCurrentUser({id:1,permissionGrants:[]});
  assert.equal(access.payrollPageAllowed(),true);
  access.refreshCurrentUser(null);
  assert.equal(access.payrollPageAllowed(),false);
  context.currentUser.role='foreman';
  access.refreshCurrentUser({id:1,permissionGrants:['payroll']});
  assert.equal(access.payrollPageAllowed(),false);
});
