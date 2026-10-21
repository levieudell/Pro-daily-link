'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const access = require('./platform-access-ui');
const policy = require('./platform-capabilities');

let checks = 0;
const check = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks += 1;
};
const dto = role => policy.platformUserDto({id: `${role}-1`, name: role, email: `${role}@example.invalid`, role, status: 'Active'});

// The browser consumes server-issued capabilities; a claimed role cannot grant access.
check(access.visibleViews(null).length, 0);
check(access.visibleViews({role: 'platform_owner', active: true}).length, 0);
check(access.hasCapability({active: true, capabilities: ['invented:permission']}, 'invented:permission'), false);
check(access.canView({active: true, capabilities: policy.ALL_CAPABILITIES}, '__proto__'), false);

const expectedViews = {
  platform_owner: ['overview', 'customers', 'onboarding', 'support', 'subscriptions', 'ai', 'blog', 'help', 'team', 'growth'],
  customer_success: ['overview', 'customers', 'onboarding', 'support', 'subscriptions', 'blog', 'help', 'growth'],
  onboarding: ['overview', 'customers', 'onboarding', 'blog', 'help'],
  support: ['overview', 'customers', 'support', 'blog', 'help'],
  billing: ['overview', 'customers', 'subscriptions', 'team'],
  engineering: ['overview', 'customers', 'support', 'ai', 'blog', 'help', 'team'],
  sales: ['overview', 'customers', 'subscriptions', 'blog', 'help', 'growth'],
  content: ['overview', 'blog', 'help']
};
for (const [role, views] of Object.entries(expectedViews)) {
  const user = dto(role);
  assert.deepEqual(access.visibleViews(user), views, role);
  checks += 1;
  check(access.firstAllowedView(user), 'overview');
  for (const view of access.VIEW_ORDER) check(access.canView(user, view), views.includes(view), `${role}: ${view}`);
}

// A DOM adapter hides unauthorized navigation and actions without treating UI as security.
function element(dataset) {
  const attrs = {};
  return {dataset, hidden: false, setAttribute(name, value) { attrs[name] = value; }, attrs};
}
const nav = element({view: 'team'}), allowedAction = element({capability: policy.CAPABILITIES.GROWTH_WRITE}), deniedAction = element({capabilityAny: `${policy.CAPABILITIES.REVENUE_READ} ${policy.CAPABILITIES.AI_USAGE_READ}`});
const documentRoot = {querySelectorAll(selector) { return selector === '[data-view]' ? [nav] : [allowedAction, deniedAction]; }};
access.applyCapabilityVisibility(documentRoot, dto('sales'));
check(nav.hidden, true);
check(nav.attrs['aria-hidden'], 'true');
check(allowedAction.hidden, false);
check(deniedAction.hidden, true);

// Static integration protects every sensitive control and never lets the user choose an impersonated actor.
const html = fs.readFileSync('platform.html', 'utf8');
const source = fs.readFileSync('platform.js', 'utf8');
check(html.includes('src="platform-access-ui.js'), true);
check(html.includes('id="platform-status"'), true);
check(html.includes('id="platform-nav-toggle"'), true);
check(html.includes('id="staff-status"'), true);
check(html.includes('id="support-actor-summary"'), true);
check(html.includes('id="support-actor"'), false);
for (const role of policy.PLATFORM_ROLES) check(html.includes(`value="${role}"`), true, `staff UI includes ${role}`);
for (const key of [
  'CUSTOMER_OWNER_RESET',
  'SUBSCRIPTION_WRITE',
  'FEATURE_WRITE',
  'DATA_LIFECYCLE_MANAGE',
  'HELP_CONTENT_WRITE',
  'SUPPORT_GRANT_CREATE',
  'STAFF_MANAGE'
]) {
  const capability=policy.CAPABILITIES[key];
  check(html.includes(`data-capability="${capability}"`) || source.includes(`PLATFORM_CAP.${key}`), true, capability);
}
check(source.includes("api(`/api/platform/users/${encodeURIComponent(editingStaffId)}`"), true);
check(source.includes("method:'PATCH'"), true);
check(source.includes("api('/api/platform/support-access'"), true);
check(source.includes('actorUserId:'), false, 'the browser cannot request impersonation');
check(source.includes('PDLPlatformAccess'), true);
check(source.includes('applyCapabilityVisibility'), true);

console.log(`${checks} platform access UI assertions passed: server-issued policy, protected views/actions, safe support access, and staff controls.`);
