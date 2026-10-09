'use strict';
const crypto = require('node:crypto');
const { validateAccounts } = require('./account-evidence');
const profiles = require('./role-profiles');
const { stripPrivate } = require('./account-credential-delivery');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode, code: 'PDL_COMPAT_ACCOUNT_INPUT' }); };
const roles = ['owner', 'admin', 'project_manager', 'foreman', 'field'];
const flags = ['scheduleCrews', 'viewTime', 'manageTime', 'viewDailies', 'approveDailies'];
const id = value => Number.isSafeInteger(value) && value > 0;
function closed(value, names) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !names.includes(name))) fail(400, 'Use only the fields supported by this account operation'); return value; }
function text(value, maximum, required = false) { if (typeof value !== 'string' || value.length > maximum || required && !value.trim()) fail(400, 'Enter a valid account value'); return value.trim(); }
function address(value) { const result = text(value, 5000, true).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Enter a valid email address'); return result; }
function directory(db) { return db.users.map(user => ({ id: user.id, companyId: db.company.id, name: user.name, email: user.email, role: user.role === 'office' ? 'admin' : user.role, status: user.status, preferredLanguage: user.preferredLanguage || 'en', projectIds: user.projectIds || [], assignedCrews: user.assignedCrews || [], permissions: user.permissions || {}, memberId: user.memberId || null, mustSetPassword: user.mustSetPassword === true, setupExpiresAt: user.setupExpiresAt || null, emailVerifiedAt: user.emailVerifiedAt || null })); }
const nextId = rows => Math.max(0, ...rows.map(row => row.id)) + 1;
function validDirectory(rows, companyId) { if (!Array.isArray(rows) || rows.some(row => !row || !id(row.id) || row.companyId !== undefined && row.companyId !== companyId) || new Set(rows.map(row => row.id)).size !== rows.length) fail(409, 'Resource identities need reconciliation'); }
function normalize(db, action, input) {
  const names = action === 'createUser' || action === 'editUser' ? ['name', 'email', 'role', 'status', 'preferredLanguage', 'projectIds', 'assignedCrews', 'permissions', 'memberId'] : action === 'createMemberAccount' ? ['name', 'role', 'crew', 'phone', 'email', 'accountRole', 'initials', 'hours', 'site'] : action === 'timeAccess' ? ['manageTime'] : action === 'preferences' ? ['scheduleCrew', 'scheduleShowOffice', 'displayName', 'theme', 'preferredLanguage', 'profilePhoto'] : [];
  closed(input, names); input = structuredClone(input);
  for (const name of ['name', 'displayName', 'crew', 'phone', 'initials', 'site', 'scheduleCrew']) if (Object.hasOwn(input, name)) input[name] = text(input[name], name === 'displayName' ? 100 : name === 'scheduleCrew' ? 60 : name === 'phone' ? 40 : name === 'initials' ? 3 : 140, ['name', 'crew'].includes(name));
  if (Object.hasOwn(input, 'email')) input.email = address(input.email);
  if (Object.hasOwn(input, 'role') && (action === 'createMemberAccount' ? typeof input.role !== 'string' || !input.role.trim() || input.role.length > 100 : !roles.includes(input.role))) fail(400, 'Choose an existing account role');
  if (Object.hasOwn(input, 'accountRole') && !roles.slice(1).includes(input.accountRole)) fail(400, 'Choose an existing account role');
  if (Object.hasOwn(input, 'preferredLanguage') && !['en', 'es'].includes(input.preferredLanguage)) fail(400, 'Choose a supported language');
  if (Object.hasOwn(input, 'status') && !['Active', 'Deactivated'].includes(input.status)) fail(400, 'Choose a supported account status');
  if (Object.hasOwn(input, 'theme') && !['light', 'dark', 'system'].includes(input.theme)) fail(400, 'Choose a supported theme');
  for (const name of ['manageTime', 'scheduleShowOffice']) if (Object.hasOwn(input, name) && typeof input[name] !== 'boolean') fail(400, 'Use a boolean account setting');
  if (input.permissions !== undefined && (!input.permissions || typeof input.permissions !== 'object' || Array.isArray(input.permissions) || Object.entries(input.permissions).some(([name, value]) => !flags.includes(name) || typeof value !== 'boolean'))) fail(400, 'Use only existing boolean individual grants');
  validDirectory(db.projects, db.company.id); validDirectory(db.team, db.company.id);
  if (input.projectIds !== undefined && (!Array.isArray(input.projectIds) || input.projectIds.some(value => !id(value) || !db.projects.some(project => project.id === value)) || new Set(input.projectIds).size !== input.projectIds.length)) fail(400, 'Choose existing company projects');
  if (input.assignedCrews !== undefined && (!Array.isArray(input.assignedCrews) || input.assignedCrews.some(value => typeof value !== 'string' || !db.team.some(member => member.crew === value)) || new Set(input.assignedCrews).size !== input.assignedCrews.length)) fail(400, 'Choose existing company crews');
  if (input.memberId !== undefined && input.memberId !== null && (!id(input.memberId) || !db.team.some(member => member.id === input.memberId && !member.archivedAt))) fail(400, 'Choose an active existing team member');
  if (input.profilePhoto !== undefined && (typeof input.profilePhoto !== 'string' || input.profilePhoto.length > 2100000 || input.profilePhoto && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(input.profilePhoto))) fail(400, 'Profile photo must be a supported image smaller than 1.5 MB');
  if (input.hours !== undefined && input.hours !== 0 || input.site !== undefined && input.site !== 'Not assigned') fail(400, 'New linked members start with no assigned work');
  return input;
}
function apply(db, auth, operation, raw, hooks, secretFactory = () => crypto.randomBytes(6).toString('base64url')) {
  validateAccounts(db); if (auth.user.role !== 'owner' || auth.user.status !== 'Active' || auth.companyId !== db.company.id) fail(403, 'Account owner permission required');
  const { action, targetId } = operation, input = normalize(db, action, raw), now = new Date(hooks.clock()).toISOString();
  let user = targetId === null ? null : db.users.find(row => row.id === targetId), temporaryPassword = null, member = null;
  if (targetId !== null && !user) fail(404, 'User not found');
  const before = user ? directory({ ...db, users: [user] })[0] : null;
  const issue = () => { temporaryPassword = secretFactory(); const credential = hooks.credentialHash(temporaryPassword); user.setupHash = credential.hash; user.setupSalt = credential.salt; user.setupExpiresAt = new Date(hooks.clock() + 72 * 3600000).toISOString(); user.mustSetPassword = true; };
  if (['createUser', 'createMemberAccount'].includes(action)) {
    if (action === 'createUser' && db.company.emailVerificationRequiredAt && !auth.user.emailVerifiedAt) fail(403, 'Confirm the account owner email before inviting team members');
    const limit = hooks.billingPlan(db.company).maxUsers; if (limit != null && db.users.filter(row => row.status === 'Active').length >= limit) fail(409, 'Your plan has reached its active-user limit');
    if (!input.name || !input.email || action === 'createUser' && !roles.includes(input.role) || action === 'createMemberAccount' && (!input.role || !input.crew || !input.accountRole)) fail(400, 'Enter the required account fields');
    if (db.users.some(row => row.email.toLowerCase() === input.email)) fail(409, 'A user with that email already exists');
    if (action === 'createUser' && input.role === 'owner' && db.users.some(row => row.role === 'owner' && row.status === 'Active')) fail(409, 'Transfer ownership instead of creating another owner');
    if (action === 'createMemberAccount') { member = { id: nextId(db.team), name: input.name, role: input.role.trim(), crew: input.crew, phone: input.phone || '', email: input.email, initials: input.initials || '', hours: 0, site: 'Not assigned' }; db.team.push(member); }
    user = { id: nextId(db.users), companyId: db.company.id, name: input.name, email: input.email, role: member ? input.accountRole : input.role, preferredLanguage: member ? 'en' : input.preferredLanguage || 'en', projectIds: member ? [] : input.projectIds || [], memberId: member ? member.id : input.memberId || null, status: 'Active', createdAt: now };
    if (!member) { user.assignedCrews = user.role === 'project_manager' ? input.assignedCrews || [] : []; user.permissions = user.role === 'project_manager' ? { scheduleCrews: input.permissions?.scheduleCrews === true, viewTime: input.permissions?.viewTime === true, manageTime: input.permissions?.manageTime === true, viewDailies: input.permissions?.viewDailies !== false, approveDailies: input.permissions?.approveDailies === true } : {}; }
    db.users.push(user); issue();
  } else if (action === 'resetCode') { if (user.status !== 'Active') fail(404, 'Active user not found'); issue(); }
  else if (action === 'timeAccess') { if (user.role === 'owner') fail(409, 'The account owner always has time access'); user.permissions = { ...(user.permissions || {}), manageTime: ['admin', 'project_manager'].includes(user.role) && input.manageTime === true }; user.updatedAt = now; }
  else if (action === 'editUser') {
    if (user.role === 'owner') fail(409, 'Owner identity and recovery authority are immutable in this editor');
    if (input.role === 'owner') fail(400, 'Ownership transfer is a separate protected operation');
    if (input.role !== undefined && input.role !== user.role && profiles.required(db) && profiles.binding(db, user).state !== 'none') fail(409, 'Remove the assigned profile through its reviewed operation before changing base role');
    if (input.email && db.users.some(row => row.id !== user.id && row.email.toLowerCase() === input.email)) fail(409, 'A user with that email already exists');
    for (const name of ['name', 'email', 'role', 'status', 'preferredLanguage']) if (Object.hasOwn(input, name)) user[name] = input[name];
    user.projectIds = user.role === 'project_manager' ? input.projectIds || user.projectIds || [] : [];
    user.assignedCrews = user.role === 'project_manager' ? input.assignedCrews || user.assignedCrews || [] : [];
    user.permissions = user.role === 'project_manager' ? { ...(user.permissions || {}), scheduleCrews: input.permissions?.scheduleCrews === true, viewTime: input.permissions?.viewTime === true, manageTime: input.permissions?.manageTime === true, viewDailies: input.permissions?.viewDailies !== false, approveDailies: input.permissions?.approveDailies === true } : user.role === 'admin' ? { ...(user.permissions || {}), manageTime: input.permissions?.manageTime === true } : {};
    user.memberId = ['foreman', 'field'].includes(user.role) ? input.memberId ?? user.memberId : null;
    if (['foreman', 'field'].includes(user.role) && !db.team.some(row => row.id === user.memberId && !row.archivedAt)) fail(400, 'Link this account to an active team member');
    user.updatedAt = now;
    if (db.company.pricingAccess?.userIds) db.company.pricingAccess.userIds = db.company.pricingAccess.userIds.filter(value => db.users.some(row => row.id === value && row.status === 'Active' && ['owner', 'admin', 'project_manager'].includes(row.role)));
  } else if (action === 'preferences') {
    user.preferences = { ...(user.preferences || {}) };
    for (const name of ['scheduleCrew', 'scheduleShowOffice', 'displayName', 'theme', 'profilePhoto']) if (Object.hasOwn(input, name)) user.preferences[name] = input[name];
    if (Object.hasOwn(input, 'scheduleCrew') && !input.scheduleCrew) user.preferences.scheduleCrew = 'all';
    if (Object.hasOwn(input, 'displayName') && !input.displayName) user.preferences.displayName = user.name;
    if (input.preferredLanguage) user.preferredLanguage = input.preferredLanguage;
  } else fail(400, 'Unsupported account action');
  if (action === 'editUser' && before.email !== user.email) {
    delete user.emailVerifiedAt;
    for (const name of ['setupHash', 'setupSalt', 'setupExpiresAt', 'setupGeneration', 'setupIssuedEmail']) delete user[name];
  }
  validateAccounts(db);
  const after = directory({ ...db, users: [user] })[0];
  const result = member ? { ...stripPrivate(member), user: after } : action === 'preferences' ? { ...require('./account-evidence').publicPreferences(user), preferredLanguage: user.preferredLanguage || 'en' } : action === 'resetCode' ? { expiresAt: user.setupExpiresAt } : after;
  return { before, after, result, targetId: user.id, temporaryPassword, status: ['createUser', 'createMemberAccount'].includes(action) ? 201 : 200, normalized: input };
}
module.exports = { normalize, apply, directory, closed, fail };
