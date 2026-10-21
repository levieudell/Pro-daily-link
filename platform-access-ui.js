(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLPlatformAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // These are protocol values returned by /api/platform/auth/me. The role to
  // capability policy lives only in platform-capabilities.js on the server.
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

  const VIEW_CAPABILITIES = Object.freeze({
    overview: Object.freeze([CAPABILITIES.OVERVIEW_READ]),
    customers: Object.freeze([CAPABILITIES.CUSTOMER_READ]),
    onboarding: Object.freeze([CAPABILITIES.ONBOARDING_READ]),
    support: Object.freeze([CAPABILITIES.SUPPORT_READ]),
    subscriptions: Object.freeze([CAPABILITIES.SUBSCRIPTION_READ, CAPABILITIES.SUBSCRIPTION_WRITE, CAPABILITIES.REVENUE_READ]),
    ai: Object.freeze([CAPABILITIES.AI_USAGE_READ]),
    blog: Object.freeze([CAPABILITIES.CONTENT_READ, CAPABILITIES.HELP_CONTENT_WRITE]),
    help: Object.freeze([CAPABILITIES.CONTENT_READ, CAPABILITIES.HELP_CONTENT_WRITE]),
    team: Object.freeze([CAPABILITIES.STAFF_MANAGE, CAPABILITIES.AUDIT_READ]),
    growth: Object.freeze([CAPABILITIES.GROWTH_READ])
  });

  const VIEW_ORDER = Object.freeze(Object.keys(VIEW_CAPABILITIES));

  function capabilitiesFor(user) {
    if (!user || user.active !== true || !Array.isArray(user.capabilities)) return new Set();
    return new Set(user.capabilities.filter(value => typeof value === 'string'));
  }

  function hasCapability(user, capability) {
    return Object.values(CAPABILITIES).includes(capability) && capabilitiesFor(user).has(capability);
  }

  function hasAnyCapability(user, capabilities) {
    return Array.isArray(capabilities) && capabilities.some(capability => hasCapability(user, capability));
  }

  function canView(user, view) {
    return Object.prototype.hasOwnProperty.call(VIEW_CAPABILITIES, view) && hasAnyCapability(user, VIEW_CAPABILITIES[view]);
  }

  function visibleViews(user) {
    return VIEW_ORDER.filter(view => canView(user, view));
  }

  function firstAllowedView(user) {
    return visibleViews(user)[0] || null;
  }

  function requestedCapabilities(element) {
    if (!element?.dataset) return [];
    if (element.dataset.capability) return [element.dataset.capability];
    if (element.dataset.capabilityAny) return element.dataset.capabilityAny.split(/\s+/).filter(Boolean);
    return [];
  }

  function applyCapabilityVisibility(documentRoot, user) {
    if (!documentRoot?.querySelectorAll) return;
    for (const element of documentRoot.querySelectorAll('[data-view]')) {
      const allowed = canView(user, element.dataset.view);
      element.hidden = !allowed;
      element.setAttribute('aria-hidden', String(!allowed));
    }
    for (const element of documentRoot.querySelectorAll('[data-capability],[data-capability-any]')) {
      const requested = requestedCapabilities(element);
      const allowed = hasAnyCapability(user, requested);
      element.hidden = !allowed;
      element.setAttribute('aria-hidden', String(!allowed));
    }
  }

  return Object.freeze({
    CAPABILITIES,
    VIEW_CAPABILITIES,
    VIEW_ORDER,
    capabilitiesFor,
    hasCapability,
    hasAnyCapability,
    canView,
    visibleViews,
    firstAllowedView,
    applyCapabilityVisibility
  });
});
