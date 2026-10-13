'use strict';
// Named existing resource operations. These identifiers are not permission flags.
const timezone = require('./company-timezone');
const extensions = [require('./resource-assets'), require('./resource-project-tasks'), require('./resource-templates'), require('./resource-catalog-contract'), require('./resource-subcontractors'), require('./resource-report-variants'), require('./resource-estimates')];
const extension = op => extensions.find(module => module.route(op.method, op.path, op.details) === op.kind) || null;
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).every(key => keys.includes(key));
const id = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
function text(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) fail(400, 'Enter bounded resource details.');
  return value.trim();
}
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) fail(400, 'Enter a finite non-negative value.'); return value; }
function ids(value, limit = 1000) { if (!Array.isArray(value) || value.length > limit || value.some(value => !id(value)) || new Set(value).size !== value.length) fail(400, 'Choose unique current record IDs.'); return [...value]; }
function bool(value) { if (typeof value !== 'boolean') fail(400, 'Use an explicit enabled or disabled setting.'); return value; }
function fields(value, limits, required = []) {
  const out = {};
  for (const [name, limit] of Object.entries(limits)) if (Object.hasOwn(value, name)) out[name] = text(value[name], limit, required.includes(name));
  for (const name of required) if (!Object.hasOwn(out, name)) fail(400, 'Complete the required resource details.');
  return out;
}
function email(value) { if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, 'Enter a valid email address.'); return value; }
function route(method, path) {
  const selected=extensions.map(module => module.route(method,path)).find(Boolean);if(selected)return selected;
  if (method === 'POST') return { '/api/customers': 'customerCreate', '/api/projects': 'projectCreate', '/api/team': 'teamCreate', '/api/crews': 'crewCreate', '/api/company-activities': 'activityCreate' }[path] || null;
  if (method === 'PATCH' && path === '/api/company') return 'companySettings';
  if (method === 'PATCH' && path === '/api/company/contract-value-tracking') return 'contractTracking';
  if (method === 'PATCH' && /^\/api\/projects\/[1-9]\d*\/archive$/.test(path)) return 'projectArchive';
  if (['PATCH', 'DELETE'].includes(method) && /^\/api\/crews\/[1-9]\d*$/.test(path)) return method === 'PATCH' ? 'crewEdit' : 'crewRemove';
  return extensions.map(module => module.route(method, path)).find(Boolean) || null;
}
function parse(value) {
  if (!object(value, ['kind', 'method', 'path', 'details']) || Object.keys(value).length !== 4 || typeof value.path !== 'string' || value.path.length > 160 || route(value.method, value.path) !== value.kind && !extension(value) || !value.kind) fail(400, 'Choose one supported resource change.');
  const family = extension(value); if (family) return family.parse(value, module.exports);
  const d = value.details;
  let out;
  if (value.kind === 'customerCreate') {
    if (!object(d, ['name', 'contact', 'phone', 'email'])) fail(400, 'Only customer contact details are accepted.');
    out = fields(d, { name: 140, contact: 140, phone: 40, email: 180 }, ['name']);
    if (out.email !== undefined) email(out.email);
  } else if (value.kind === 'teamCreate') {
    if (!object(d, ['name', 'role', 'crew', 'phone', 'email', 'initials', 'accountRole', 'hours', 'site']) || Object.hasOwn(d, 'accountRole') && d.accountRole !== '' || Object.hasOwn(d, 'hours') && d.hours !== 0 || Object.hasOwn(d, 'site') && d.site !== 'Not assigned') fail(400, 'Employee details cannot create login access or work history.');
    out = fields(d, { name: 100, role: 80, crew: 120, phone: 40, email: 180, initials: 3 }, ['name', 'role', 'crew']);
    if (out.email !== undefined) email(out.email);
    out.hours = 0; out.site = 'Not assigned';
  } else if (value.kind === 'projectCreate') {
    const keys = ['customerId', 'customer', 'name', 'contractType', 'tmSettings', 'code', 'budget', 'site', 'startDate', 'endDate', 'supervisor', 'siteContact', 'estimateItems', 'color', 'crew', 'progress', 'production', 'status', 'templateId'];
    const unlinked = d?.customerId === null && d.customer === '';
    if (!object(d, keys) || !unlinked && !id(d.customerId) || !['estimated', 'tm', 'hybrid'].includes(d.contractType)) fail(400, 'Choose a current customer or leave it unset, and choose a supported contract type.');
    out = fields(d, { customer: 140, name: 220, code: 40, budget: 120, site: 500, startDate: 10, endDate: 10, supervisor: 100, siteContact: 200, templateId: 80 }, unlinked ? ['name'] : ['customer', 'name']);
    for (const key of ['startDate', 'endDate']) if (out[key] && !date(out[key])) fail(400, 'Enter valid project dates.');
    if (out.startDate && out.endDate && out.endDate < out.startDate) fail(400, 'Project end cannot precede its start.');
    if (out.budget !== undefined && !/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(out.budget)) fail(400, 'Enter a finite non-negative project budget.');
    if (out.budget !== undefined) number(Number(out.budget.replace(/[$,]/g, '')));
    if (d.contractType === 'estimated') { if (d.tmSettings != null) fail(400, 'Estimated projects do not set T&M rates.'); out.tmSettings = null; }
    else {
      if (!object(d.tmSettings, ['defaultLaborRate', 'materialMarkup', 'equipmentMarkup']) || Object.keys(d.tmSettings).length !== 3) fail(400, 'Enter the three supported T&M rates.');
      out.tmSettings = Object.fromEntries(Object.entries(d.tmSettings).map(([key, value]) => [key, number(value)]));
    }
    for (const [key, initial] of Object.entries({ color: '#e7effd', crew: 0, progress: 0, production: 0, status: 'On track' })) if (Object.hasOwn(d, key) && d[key] !== initial) fail(400, 'Project operational state is generated by the server.');
    if (Object.hasOwn(d, 'estimateItems') && (!Array.isArray(d.estimateItems) || d.estimateItems.length)) fail(400, 'Add estimate rows through their protected workflow.');
    Object.assign(out, { customerId: d.customerId, contractType: d.contractType, estimateItems: [], color: '#e7effd', crew: 0, progress: 0, production: 0, status: 'On track' });
  } else if (value.kind === 'crewCreate' || value.kind === 'crewEdit') {
    if (!object(d, ['name', 'memberIds']) || Object.keys(d).length !== 2) fail(400, 'Choose a crew name and its current members.');
    out = { name: text(d.name, 120, true), memberIds: ids(d.memberIds) };
    if (/^(office|unassigned)$/i.test(out.name)) fail(400, 'Office and Unassigned are protected directory labels.');
  } else if (value.kind === 'crewRemove') {
    if (!object(d, []) || Object.keys(d).length) fail(400, 'Crew removal accepts no arbitrary record fields.'); out = {};
  } else if (value.kind === 'projectArchive') {
    if (!object(d, ['archived']) || Object.keys(d).length !== 1) fail(400, 'Choose archive or restore explicitly.'); out = { archived: bool(d.archived) };
  } else if (value.kind === 'contractTracking') {
    if (!object(d, ['enabled']) || Object.keys(d).length !== 1) fail(400, 'Choose contract tracking explicitly.'); out = { enabled: bool(d.enabled) };
  } else if (value.kind === 'activityCreate') {
    if (!object(d, ['name']) || Object.keys(d).length !== 1) fail(400, 'Enter only the activity name.'); out = { name: text(d.name, 80, true) };
  } else if (value.kind === 'companySettings') {
    const keys = ['name', 'trade', 'email', 'phone', 'timezone', 'timezoneSelected', 'weekStart', 'overtimeRule', 'scheduleGraceMinutes', 'autoAdoptActualTimes', 'pricingAccess', 'contractValueTracking'];
    if (!object(d, keys)) fail(400, 'Only the existing Company settings may change.');
    out = fields(d, { name: 120, trade: 120, email: 160, phone: 40, timezone: 100 }, ['name']);
    if (out.email !== undefined) email(out.email);
    for (const key of ['timezoneSelected', 'autoAdoptActualTimes', 'contractValueTracking']) if (Object.hasOwn(d, key)) out[key] = bool(d[key]);
    if (Object.hasOwn(d, 'weekStart')) { if (!['sunday', 'monday'].includes(d.weekStart)) fail(400, 'Choose Sunday or Monday.'); out.weekStart = d.weekStart; }
    if (Object.hasOwn(d, 'overtimeRule')) { if (!['weekly40', 'daily8', 'daily8_weekly40', 'none'].includes(d.overtimeRule)) fail(400, 'Choose a supported overtime rule.'); out.overtimeRule = d.overtimeRule; }
    if (Object.hasOwn(d, 'scheduleGraceMinutes')) { number(d.scheduleGraceMinutes); if (d.scheduleGraceMinutes < 5 || d.scheduleGraceMinutes > 120) fail(400, 'Schedule grace must be five to 120 minutes.'); out.scheduleGraceMinutes = Math.round(d.scheduleGraceMinutes); }
    if (Object.hasOwn(d, 'pricingAccess')) {
      const p = d.pricingAccess;
      if (!object(p, ['enabled', 'officeMode', 'userIds']) || Object.keys(p).length !== 3 || !['all', 'selected'].includes(p.officeMode)) fail(400, 'Choose the existing pricing visibility settings.');
      out.pricingAccess = { enabled: bool(p.enabled), officeMode: p.officeMode, userIds: ids(p.userIds) };
    }
  }
  return { kind: value.kind, method: value.method, path: value.path, details: out };
}
function authorizeActor(auth, op) {
  const user = auth?.user;
  if (!user || user.status !== 'Active' || !['owner', 'admin', 'project_manager', 'foreman', 'field'].includes(user.role)) fail(403, 'A current company account is required.');
  const family = extension(op); if (family) return family.authorizeActor(auth, op, module.exports);
  // The three inherited creation handlers have broad authenticated baselines.
  // Do not misrepresent them as an Office role grant introduced by this draft.
  if (!['customerCreate', 'projectCreate', 'teamCreate', 'activityCreate'].includes(op.kind) && !['owner', 'admin'].includes(user.role)) fail(403, 'Current Owner or Admin permission required.');
  if (op.kind === 'activityCreate' && !(user.role === 'owner' || ['admin', 'project_manager'].includes(user.role) && user.permissions?.manageTime === true)) fail(403, 'Current time-management permission required.');
}
function protectedMembers(db) {const profiles=require('./role-profiles');profiles.read(db);return new Set(db.users.filter(row=>row.role==='owner'||profiles.binding(db,row).kind==='office').map(row=>Number(row.memberId)).filter(id));}
function eligibleMembers(db) {const protectedIds=protectedMembers(db);return db.team.filter(row=>!protectedIds.has(Number(row.id))&&!row.archivedAt&&!row.archived&&row.status!=='Inactive').map(row=>Number(row.id));}
function authorize(db, auth, op, helpers) {
  authorizeActor(auth, op);const user=auth.user;
  const family = extension(op); if (family) return family.authorize(db, auth, op, helpers, module.exports);
  if (op.kind === 'projectCreate') {
    if (op.details.customerId !== null) {
      const customer = db.customers.find(row => Number(row.id) === op.details.customerId);
      if (!customer || customer.name !== op.details.customer) fail(404, 'Selected customer not found.');
    }
    if (op.details.supervisor && db.team.filter(row => row.name === op.details.supervisor).length !== 1) fail(404, 'Selected supervisor not found.');
    if (!helpers.canViewPricing(db, user) && (Number((op.details.budget || '0').replace(/[$,]/g, '')) > 0 || Object.values(op.details.tmSettings || {}).some(value => value > 0))) fail(403, 'Financial project values require existing pricing access.');
    if (op.details.templateId && (db.company.features?.templates !== true || op.details.templateId !== 'standard' && !(db.dailyTemplates || []).some(row => String(row.id) === op.details.templateId))) fail(404, 'Selected template not found.');
  }
  if (op.kind === 'projectArchive' && !db.projects.some(row => row.id === Number(op.path.split('/')[3]))) fail(404, 'Project not found.');
  if (['crewEdit', 'crewRemove'].includes(op.kind) && !(db.crews || []).some(row => row.id === Number(op.path.split('/')[3]))) fail(404, 'Crew not found.');
  if (op.kind.startsWith('crew')) {
    const crew = (db.crews || []).find(row => row.id === Number(op.path.split('/')[3]));
    if (crew && /^(office|unassigned)$/i.test(crew.name)) fail(409, 'The protected directory label cannot be edited.');
    const protectedIds = protectedMembers(db);
    for (const memberId of op.details.memberIds || []) {
      const member = db.team.find(row => Number(row.id) === memberId);
      if (!member) fail(404, 'Crew member not found.');
      if (member.archivedAt || member.archived || member.status === 'Inactive') fail(409, 'Archived employees cannot receive new crew membership.');
      if (protectedIds.has(memberId)) fail(409, 'Owner and Office-profile employee bindings are protected.');
    }
    if (crew && db.team.some(row => protectedIds.has(Number(row.id)) && String(row.crew).toLowerCase() === crew.name.toLowerCase())) fail(409, 'Owner and Office-profile employee bindings are protected.');
  }
  if (op.kind === 'companySettings') {
    const change = timezone.change(db.company, op.details); if (change.error) fail(400, change.error);
    if (op.details.pricingAccess?.userIds.some(value => !db.users.some(row => row.id === value && row.status === 'Active' && ['owner', 'admin', 'project_manager'].includes(row.role)))) fail(404, 'Pricing account not found.');
  }
}
module.exports = { route, parse, authorize, authorizeActor, extension, eligibleMembers, object, id, date, text, number, fail };
