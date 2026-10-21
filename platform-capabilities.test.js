'use strict';

const assert = require('node:assert/strict');
const {
  PLATFORM_ROLES,
  CAPABILITIES,
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  PlatformAuthorizationError,
  activePlatformUser,
  knownRole,
  knownCapability,
  platformCapabilitiesFor,
  platformCapabilityDecision,
  canPlatformUser,
  requirePlatformCapability,
  platformUserDto
} = require('./platform-capabilities');

const user = (role, extra = {}) => ({
  id: `${role}-1`,
  name: `Synthetic ${role}`,
  email: `${role}@example.invalid`,
  role,
  status: 'Active',
  ...extra
});

let checks = 0;
const check = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks += 1;
};

// The public policy vocabulary is complete, unique, immutable, and typo-safe.
check(PLATFORM_ROLES.length, 8);
check(new Set(PLATFORM_ROLES).size, PLATFORM_ROLES.length);
check(ALL_CAPABILITIES.length, 23);
check(new Set(ALL_CAPABILITIES).size, ALL_CAPABILITIES.length);
check(Object.isFrozen(PLATFORM_ROLES), true);
check(Object.isFrozen(CAPABILITIES), true);
check(Object.isFrozen(ROLE_CAPABILITIES), true);
for (const role of PLATFORM_ROLES) {
  check(knownRole(role), true, role);
  check(Object.isFrozen(ROLE_CAPABILITIES[role]), true, `${role} policy must be immutable`);
}
for (const capability of ALL_CAPABILITIES) check(knownCapability(capability), true, capability);

// Missing, malformed, inactive, password-reset, and fabricated identities deny everything.
const deniedUsers = [
  null,
  {},
  { role: 'platform_owner', status: 'Active' },
  user('platform_owner', { id: '' }),
  user('made_up_role'),
  user('platform_owner', { status: 'Inactive' }),
  user('platform_owner', { status: 'active' }),
  user('platform_owner', { mustSetPassword: true }),
  user('platform_owner ', { status: 'Active' })
];
for (const denied of deniedUsers) {
  check(activePlatformUser(denied), false);
  check(platformCapabilitiesFor(denied).length, 0);
  for (const capability of ALL_CAPABILITIES) {
    check(canPlatformUser(denied, capability, { actorUserId: denied?.id }), false);
  }
}
check(knownRole('__proto__'), false);
check(knownRole('constructor'), false);
check(knownCapability('staff:manage '), false);
check(canPlatformUser(user('platform_owner'), 'invented:permission'), false);
check(canPlatformUser(user('sales', { capabilities: ALL_CAPABILITIES }), CAPABILITIES.STAFF_MANAGE), false, 'claims on user objects cannot expand access');

// Owners have every declared capability, including cross-staff support-grant administration.
const owner = user('platform_owner');
for (const capability of ALL_CAPABILITIES) {
  check(canPlatformUser(owner, capability, { actorUserId: 'another-staff-user' }), true, `owner ${capability}`);
}

// High-risk identity, staff, and demo-reset actions stay owner-only.
for (const role of PLATFORM_ROLES.filter(role => role !== 'platform_owner')) {
  const actor = user(role);
  for (const capability of [
    CAPABILITIES.CUSTOMER_OWNER_RESET,
    CAPABILITIES.DEMO_RESET,
    CAPABILITIES.DATA_LIFECYCLE_MANAGE,
    CAPABILITIES.STAFF_MANAGE
  ]) {
    check(canPlatformUser(actor, capability, { actorUserId: actor.id }), false, `${role} cannot ${capability}`);
  }
}

// Commercial, configuration, content, growth, revenue, and AI access are deliberately scoped.
const expected = {
  customer_success: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.ONBOARDING_READ, CAPABILITIES.ONBOARDING_WRITE, CAPABILITIES.SUPPORT_READ, CAPABILITIES.SUPPORT_WRITE, CAPABILITIES.SUBSCRIPTION_READ, CAPABILITIES.CONTENT_READ, CAPABILITIES.GROWTH_READ],
  onboarding: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.ONBOARDING_READ, CAPABILITIES.ONBOARDING_WRITE, CAPABILITIES.CONTENT_READ],
  support: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.SUPPORT_READ, CAPABILITIES.SUPPORT_WRITE, CAPABILITIES.CONTENT_READ],
  billing: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.SUBSCRIPTION_READ, CAPABILITIES.REVENUE_READ, CAPABILITIES.AUDIT_READ],
  engineering: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.SUPPORT_READ, CAPABILITIES.CONTENT_READ, CAPABILITIES.AI_USAGE_READ, CAPABILITIES.AUDIT_READ],
  sales: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CUSTOMER_READ, CAPABILITIES.SUBSCRIPTION_READ, CAPABILITIES.CONTENT_READ, CAPABILITIES.GROWTH_READ, CAPABILITIES.GROWTH_WRITE],
  content: [CAPABILITIES.OVERVIEW_READ, CAPABILITIES.CONTENT_READ, CAPABILITIES.HELP_CONTENT_WRITE]
};
for (const [role, allowed] of Object.entries(expected)) {
  const actor = user(role);
  for (const capability of ALL_CAPABILITIES.filter(capability => ![
    CAPABILITIES.CUSTOMER_OWNER_RESET,
    CAPABILITIES.DEMO_RESET,
    CAPABILITIES.DATA_LIFECYCLE_MANAGE,
    CAPABILITIES.STAFF_MANAGE,
    CAPABILITIES.SUPPORT_GRANT_CREATE,
    CAPABILITIES.SUPPORT_GRANT_REVOKE,
    CAPABILITIES.SUPPORT_GRANT_READ
  ].includes(capability))) {
    check(canPlatformUser(actor, capability), allowed.includes(capability), `${role} ${capability}`);
  }
}

// Support access is useful without enabling impersonation of another staff member.
for (const role of ['customer_success', 'support', 'engineering']) {
  const actor = user(role);
  for (const capability of [
    CAPABILITIES.SUPPORT_GRANT_CREATE,
    CAPABILITIES.SUPPORT_GRANT_REVOKE,
    CAPABILITIES.SUPPORT_GRANT_READ
  ]) {
    check(canPlatformUser(actor, capability), false, `${role} needs an explicit grant scope`);
    check(canPlatformUser(actor, capability, { actorUserId: actor.id }), true, `${role} may handle own grant`);
    check(canPlatformUser(actor, capability, { grantActorUserId: actor.id }), true);
    check(canPlatformUser(actor, capability, { grant: { actorUserId: actor.id } }), true);
    check(canPlatformUser(actor, capability, { actorUserId: 'another-staff-user' }), false, `${role} may not handle another staff grant`);
  }
}
for (const role of ['onboarding', 'billing', 'sales', 'content']) {
  const actor = user(role);
  for (const capability of [CAPABILITIES.SUPPORT_GRANT_CREATE, CAPABILITIES.SUPPORT_GRANT_REVOKE, CAPABILITIES.SUPPORT_GRANT_READ]) {
    check(canPlatformUser(actor, capability, { actorUserId: actor.id }), false);
  }
}

// Decisions are safe to log, and guards fail closed with a stable HTTP-facing error.
check(platformCapabilityDecision(user('sales'), CAPABILITIES.GROWTH_WRITE).reason, 'allowed');
check(platformCapabilityDecision(user('sales'), CAPABILITIES.REVENUE_READ).reason, 'capability_not_granted');
check(platformCapabilityDecision(user('support'), CAPABILITIES.SUPPORT_GRANT_CREATE).reason, 'support_grant_scope_denied');
check(platformCapabilityDecision(null, CAPABILITIES.OVERVIEW_READ).reason, 'active_platform_user_required');
check(platformCapabilityDecision(owner, 'unknown:action').reason, 'unknown_capability');
check(requirePlatformCapability(user('sales'), CAPABILITIES.GROWTH_WRITE), true);
assert.throws(
  () => requirePlatformCapability(user('sales'), CAPABILITIES.STAFF_MANAGE),
  error => {
    checks += 4;
    return error instanceof PlatformAuthorizationError &&
      error.code === 'PDL_PLATFORM_FORBIDDEN' &&
      error.statusCode === 403 &&
      error.message === 'This back-office action is not permitted.';
  }
);

// The DTO is allowlist-based: no password, recovery, setup, token, or session material leaks.
const dto = platformUserDto(user('support', {
  passwordHash: 'SECRET',
  passwordSalt: 'SECRET',
  setupHash: 'SECRET',
  setupSalt: 'SECRET',
  setupCode: 'SECRET',
  sessionToken: 'SECRET',
  sessions: ['SECRET'],
  arbitraryFutureSecret: 'SECRET'
}));
check(dto.role, 'support');
check(dto.active, true);
check(dto.supportGrantScope, 'own');
check(dto.capabilities.includes(CAPABILITIES.SUPPORT_GRANT_CREATE), true);
check(Object.isFrozen(dto), true);
check(Object.isFrozen(dto.capabilities), true);
for (const secret of ['passwordHash', 'passwordSalt', 'setupHash', 'setupSalt', 'setupCode', 'sessionToken', 'sessions', 'arbitraryFutureSecret']) {
  check(Object.prototype.hasOwnProperty.call(dto, secret), false, `${secret} must not leak`);
}
check(platformUserDto(owner).supportGrantScope, 'all');
check(platformUserDto(user('billing')).supportGrantScope, 'none');
check(platformUserDto(user('platform_owner', { status: 'Inactive' })).capabilities.length, 0);

console.log(`${checks} platform capability assertions passed: deny-by-default, owner-only actions, scoped support grants, role boundaries, and safe DTOs.`);
