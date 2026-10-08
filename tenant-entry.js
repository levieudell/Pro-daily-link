'use strict';
// Selected-host entry is outside editable role policy. No email directory lookup.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
function company(req, activation, { entry = false } = {}) {
  const header = String(req.headers['x-pdl-company'] || '').trim();
  const stored = String(req.headers.cookie || '').split(';').map(row => row.trim()).find(row => row.startsWith('pdl_company='))?.slice(12) || '';
  if (header && stored && header !== stored) fail(400, 'A matching explicit company identifier is required.');
  if ([header, stored].some(value => value && !uuid(value))) fail(400, 'A canonical company identifier is required.');
  const selected = header || stored || (entry ? activation.companyId : '');
  if (!uuid(selected)) fail(400, 'An explicit company identifier is required.');
  if (!activation.enabled || (activation.companyId ? selected !== activation.companyId : !activation.synthetic)) fail(401, 'Company is outside this dedicated workspace.');
  return selected;
}
function input(value, kind, companyId) {
  const allowed = kind === 'login' ? ['email', 'password', 'companyId'] : kind === 'company' ? ['email', 'companyId'] : ['companyId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Invalid account entry request.');
  if (Object.hasOwn(value, 'companyId') && value.companyId !== companyId) fail(400, 'Conflicting company identity.');
  if (kind !== 'logout') {
    // Match the existing finite account DTO and request transport ceilings; do
    // not add a shorter password cap that would lock out existing credentials.
    if (typeof value.email !== 'string' || !value.email.trim() || value.email.length > 5000) fail(400, 'Enter a valid email address.');
    if (kind === 'login' && (typeof value.password !== 'string' || !value.password || value.password.length > 16_000_000)) fail(400, 'Enter a valid password.');
  }
  return value;
}
function discovery(req, activation, value) {
  // Unbound multi-tenant mode exists only for synthetic API fixtures, and cannot
  // be turned into an unauthenticated tenant/account search.
  if (!activation.companyId) fail(503, 'Company entry requires a dedicated tenant binding.');
  const selected = company(req, activation, { entry: true }); input(value, 'company', selected);
  return { companyId: selected };
}
module.exports = { company, input, discovery };
