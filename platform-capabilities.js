'use strict';

/**
 * Deny-by-default authorization policy for the Pro Daily Link back office.
 *
 * Keep this module free of HTTP, persistence, and UI concerns. Route handlers
 * should ask `canPlatformUser(...)` immediately before reading or mutating a
 * protected resource. A visible button is never an authorization boundary.
 */

const PLATFORM_ROLES = Object.freeze([
  'platform_owner',
  'customer_success',
  'onboarding',
  'support',
  'billing',
  'engineering',
  'sales',
  'content'
]);

const CAPABILITIES = Object.freeze({
  OVERVIEW_READ: 'overview:read',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_OWNER_RESET: 'customer-owner:reset',
  ONBOARDING_READ: 'onboarding:read',
  ONBOARDING_WRITE: 'onboarding:write',
  SUPPORT_READ: 'support:read',
  SUPPORT_WRITE: 'support:write',
  SUBSCRIPTION_READ: 'subscription:read',
  SUBSCRIPTION_WRITE: 'subscription:write',
  FEATURE_WRITE: 'feature:write',
  DATA_LIFECYCLE_MANAGE: 'data-lifecycle:manage',
  CONTENT_READ: 'content:read',
  HELP_CONTENT_WRITE: 'help-content:write',
  SUPPORT_GRANT_CREATE: 'support-grant:create',
  SUPPORT_GRANT_REVOKE: 'support-grant:revoke',
  SUPPORT_GRANT_READ: 'support-grant:read',
  DEMO_RESET: 'demo:reset',
  STAFF_MANAGE: 'staff:manage',
  GROWTH_READ: 'growth:read',
  GROWTH_WRITE: 'growth:write',
  REVENUE_READ: 'revenue:read',
  AI_USAGE_READ: 'ai-usage:read',
  AUDIT_READ: 'audit:read'
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

const ROLE_CAPABILITIES = freezePolicy({
  platform_owner: ALL_CAPABILITIES,
  customer_success: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.ONBOARDING_READ,
    CAPABILITIES.ONBOARDING_WRITE,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.SUPPORT_WRITE,
    CAPABILITIES.SUBSCRIPTION_READ,
    CAPABILITIES.CONTENT_READ,
    CAPABILITIES.SUPPORT_GRANT_CREATE,
    CAPABILITIES.SUPPORT_GRANT_REVOKE,
    CAPABILITIES.SUPPORT_GRANT_READ,
    CAPABILITIES.GROWTH_READ
  ],
  onboarding: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.ONBOARDING_READ,
    CAPABILITIES.ONBOARDING_WRITE,
    CAPABILITIES.CONTENT_READ
  ],
  support: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.SUPPORT_WRITE,
    CAPABILITIES.CONTENT_READ,
    CAPABILITIES.SUPPORT_GRANT_CREATE,
    CAPABILITIES.SUPPORT_GRANT_REVOKE,
    CAPABILITIES.SUPPORT_GRANT_READ
  ],
  billing: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.SUBSCRIPTION_READ,
    CAPABILITIES.REVENUE_READ,
    CAPABILITIES.AUDIT_READ
  ],
  engineering: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.CONTENT_READ,
    CAPABILITIES.SUPPORT_GRANT_CREATE,
    CAPABILITIES.SUPPORT_GRANT_REVOKE,
    CAPABILITIES.SUPPORT_GRANT_READ,
    CAPABILITIES.AI_USAGE_READ,
    CAPABILITIES.AUDIT_READ
  ],
  sales: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CUSTOMER_READ,
    CAPABILITIES.SUBSCRIPTION_READ,
    CAPABILITIES.CONTENT_READ,
    CAPABILITIES.GROWTH_READ,
    CAPABILITIES.GROWTH_WRITE
  ],
  content: [
    CAPABILITIES.OVERVIEW_READ,
    CAPABILITIES.CONTENT_READ,
    CAPABILITIES.HELP_CONTENT_WRITE
  ]
});

const SUPPORT_GRANT_CAPABILITIES = new Set([
  CAPABILITIES.SUPPORT_GRANT_CREATE,
  CAPABILITIES.SUPPORT_GRANT_REVOKE,
  CAPABILITIES.SUPPORT_GRANT_READ
]);

function freezePolicy(policy) {
  const frozen = {};
  for (const [role, capabilities] of Object.entries(policy)) {
    frozen[role] = Object.freeze([...capabilities]);
  }
  return Object.freeze(frozen);
}

function knownRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role);
}

function knownCapability(capability) {
  return typeof capability === 'string' && ALL_CAPABILITIES.includes(capability);
}

function activePlatformUser(user) {
  return Boolean(
    user &&
    typeof user === 'object' &&
    user.id !== undefined &&
    user.id !== null &&
    String(user.id).length > 0 &&
    user.status === 'Active' &&
    user.mustSetPassword !== true &&
    knownRole(user.role)
  );
}

function platformCapabilitiesFor(user) {
  if (!activePlatformUser(user)) return [];
  return [...ROLE_CAPABILITIES[user.role]];
}

function sameIdentifier(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return String(left) === String(right);
}

function supportGrantActorId(context) {
  if (!context || typeof context !== 'object') return null;
  if (context.actorUserId !== undefined) return context.actorUserId;
  if (context.grantActorUserId !== undefined) return context.grantActorUserId;
  return context.grant && typeof context.grant === 'object' ? context.grant.actorUserId : null;
}

function supportGrantScopeAllowed(user, context) {
  // Owners may grant/revoke/read for another active platform staff member.
  if (user.role === 'platform_owner') return true;
  // Everyone else may only create, inspect, or revoke their own audited grant.
  return sameIdentifier(user.id, supportGrantActorId(context));
}

function platformCapabilityDecision(user, capability, context = {}) {
  if (!activePlatformUser(user)) {
    return Object.freeze({ allowed: false, reason: 'active_platform_user_required' });
  }
  if (!knownCapability(capability)) {
    return Object.freeze({ allowed: false, reason: 'unknown_capability' });
  }
  if (!ROLE_CAPABILITIES[user.role].includes(capability)) {
    return Object.freeze({ allowed: false, reason: 'capability_not_granted' });
  }
  if (SUPPORT_GRANT_CAPABILITIES.has(capability) && !supportGrantScopeAllowed(user, context)) {
    return Object.freeze({ allowed: false, reason: 'support_grant_scope_denied' });
  }
  return Object.freeze({ allowed: true, reason: 'allowed' });
}

function canPlatformUser(user, capability, context = {}) {
  return platformCapabilityDecision(user, capability, context).allowed;
}

class PlatformAuthorizationError extends Error {
  constructor(decision) {
    super('This back-office action is not permitted.');
    this.name = 'PlatformAuthorizationError';
    this.code = 'PDL_PLATFORM_FORBIDDEN';
    this.statusCode = 403;
    this.reason = decision.reason;
  }
}

function requirePlatformCapability(user, capability, context = {}) {
  const decision = platformCapabilityDecision(user, capability, context);
  if (!decision.allowed) throw new PlatformAuthorizationError(decision);
  return true;
}

/**
 * Safe representation for an authenticated platform user's own session.
 * Credential, setup, recovery, and session fields are copied from an allowlist,
 * never from the source object by exclusion.
 */
function platformUserDto(user) {
  const valid = activePlatformUser(user);
  return Object.freeze({
    id: user?.id ?? null,
    name: typeof user?.name === 'string' ? user.name : '',
    email: typeof user?.email === 'string' ? user.email : '',
    role: knownRole(user?.role) ? user.role : null,
    status: typeof user?.status === 'string' ? user.status : '',
    active: valid,
    capabilities: Object.freeze(platformCapabilitiesFor(user)),
    supportGrantScope: valid && ROLE_CAPABILITIES[user.role].some(capability => SUPPORT_GRANT_CAPABILITIES.has(capability))
      ? (user.role === 'platform_owner' ? 'all' : 'own')
      : 'none'
  });
}

module.exports = Object.freeze({
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
});
