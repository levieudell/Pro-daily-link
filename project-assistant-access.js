(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLAssistantAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  // Owner-authorized pilot tenant. A display name, role, request field or
  // environment variable cannot expand this rollout. Existing RBAC still applies.
  const PILOT_COMPANY_ID = '21c12cd3-4822-4b1e-94e8-beca44efc0b7';
  const permittedCompany = companyId => typeof companyId === 'string' && companyId === PILOT_COMPANY_ID;
  const assistantPath = pathname => /^\/api\/(?:assistant(?:\/|$)|projects\/[^/]+\/assistant(?:\/|$))/.test(pathname);
  return Object.freeze({ permittedCompany, assistantPath });
});
