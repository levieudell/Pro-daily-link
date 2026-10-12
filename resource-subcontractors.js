'use strict';
// Four named, existing subcontractor writers. These are route identifiers,
// never caller-selected permission flags or a grant to guest project access.
const { canonicalHash } = require('./database/transactional-repository');
const dto = require('./compat-workspace-projections');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const kinds = ['subcontractorCreate', 'subcontractorProfile', 'subcontractorCompliance', 'subcontractorArchive'];
const profile = ['name', 'trade', 'contact', 'email', 'phone', 'insuranceExpiration', 'workersCompExpiration', 'licenseNumber', 'licenseExpiration', 'w9Received', 'agreementSigned', 'autoComplianceReminders', 'notes'];
const compliance = ['insuranceExpiration', 'workersCompExpiration', 'licenseNumber', 'licenseExpiration', 'w9Received', 'agreementSigned', 'autoComplianceReminders', 'notes'];
const dates = ['insuranceExpiration', 'workersCompExpiration', 'licenseExpiration'];
const booleans = ['w9Received', 'agreementSigned', 'autoComplianceReminders'];
const limits = { name: 140, trade: 140, contact: 140, email: 180, phone: 40, licenseNumber: 100, notes: 2000 };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const target = op => Number(op.path.split('/')[3]);
const effectsFail = input => input.fail(409, 'Subcontractor effects require reconciliation.');

function route(method, path) {
  if (method === 'POST' && path === '/api/subcontractors') return 'subcontractorCreate';
  if (method !== 'PATCH') return null;
  if (/^\/api\/subcontractors\/[1-9]\d*\/profile$/.test(path)) return 'subcontractorProfile';
  if (/^\/api\/subcontractors\/[1-9]\d*\/archive$/.test(path)) return 'subcontractorArchive';
  if (/^\/api\/subcontractors\/[1-9]\d*$/.test(path)) return 'subcontractorCompliance';
  return null;
}

function parse(op, input) {
  if (!input.object(op, ['kind', 'method', 'path', 'details']) || Object.keys(op).length !== 4 || typeof op.path !== 'string' || op.path.length > 160 || route(op.method, op.path) !== op.kind || !kinds.includes(op.kind)) input.fail(400, 'Choose one supported subcontractor change.');
  if (op.kind !== 'subcontractorCreate' && !input.id(target(op))) input.fail(400, 'Choose a current subcontractor.');
  const d = op.details;
  if (op.kind === 'subcontractorArchive') {
    if (!input.object(d, ['archived', 'reason']) || typeof d.archived !== 'boolean') input.fail(400, 'Choose archive or restore explicitly.');
    const reason = Object.hasOwn(d, 'reason') ? input.text(d.reason, 500, d.archived) : '';
    if (d.archived && !reason) input.fail(400, 'Explain why this subcontractor is being archived.');
    return { kind: op.kind, method: op.method, path: op.path, details: { archived: d.archived, reason } };
  }
  const allowed = op.kind === 'subcontractorCompliance' ? compliance : [...profile, ...(op.kind === 'subcontractorCreate' ? ['status'] : [])];
  if (!input.object(d, allowed) || !Object.keys(d).length || op.kind === 'subcontractorCreate' && Object.hasOwn(d, 'status') && d.status !== 'Active') input.fail(400, 'Only existing subcontractor contact and compliance details may change.');
  const out = {};
  for (const [key, limit] of Object.entries(limits)) if (Object.hasOwn(d, key)) out[key] = input.text(d[key], limit, key === 'name');
  if (op.kind === 'subcontractorCreate') {
    if (!out.name) input.fail(400, 'Subcontractor company name is required.');
    out.email ??= ''; out.phone ??= ''; out.status = 'Active';
  }
  if (Object.hasOwn(out, 'email')) {
    out.email = out.email.toLowerCase();
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) input.fail(400, 'Enter a valid subcontractor email.');
  }
  if (out.phone) {
    const length = out.phone.replace(/\D/g, '').length;
    if (length < 7 || length > 15) input.fail(400, 'Enter a valid subcontractor phone number.');
  }
  for (const key of dates) if (Object.hasOwn(d, key)) {
    if (d[key] !== '' && !input.date(d[key])) input.fail(400, 'Enter valid subcontractor expiration dates.');
    out[key] = d[key];
  }
  for (const key of booleans) if (Object.hasOwn(d, key)) {
    if (typeof d[key] !== 'boolean') input.fail(400, 'Use explicit subcontractor compliance settings.');
    out[key] = d[key];
  }
  return { kind: op.kind, method: op.method, path: op.path, details: out };
}

function authorizeActor(auth, op, input) {
  // The early server guard applies to PATCH /:id as well as /profile. The
  // later compliance handler's PM check does not broaden that real baseline.
  if (!kinds.includes(op.kind) || !auth?.user || auth.user.status !== 'Active' || !['owner', 'admin'].includes(auth.user.role)) input.fail(403, 'Current Owner or Admin permission required.');
}

function sources(db, input) {
  if (!db.company || !Array.isArray(db.subcontractors) || db.subcontractors.length > 10000) effectsFail(input);
  const seen = new Set();
  for (const row of db.subcontractors) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !input.id(Number(row.id)) || !/^[1-9]\d*$/.test(String(row.id)) || seen.has(Number(row.id)) || row.companyId !== undefined && row.companyId !== db.company.id || typeof row.name !== 'string' || !row.name.trim()) effectsFail(input);
    seen.add(Number(row.id));
    if (row.complianceHistory !== undefined && (!Array.isArray(row.complianceHistory) || row.complianceHistory.length > 10000 || row.complianceHistory.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)))) effectsFail(input);
    if (row.complianceReminderStages !== undefined && (!row.complianceReminderStages || typeof row.complianceReminderStages !== 'object' || Array.isArray(row.complianceReminderStages))) effectsFail(input);
  }
  const links = db.subcontractorLinks ?? [];
  if (!Array.isArray(links) || links.length > 50000) effectsFail(input);
  const ids = new Set();
  for (const row of links) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !['string', 'number'].includes(typeof row.id) || !String(row.id) || ids.has(String(row.id)) || row.companyId !== undefined && row.companyId !== db.company.id || !input.id(Number(row.subcontractorId)) || !seen.has(Number(row.subcontractorId)) || !(db.projects || []).some(project => Number(project.id) === Number(row.projectId))) effectsFail(input);
    ids.add(String(row.id));
  }
  return db.subcontractors;
}

function jobs(db, input, h) {
  if (!Object.hasOwn(db, 'workspaceComplianceJobs')) return [];
  if (typeof h.validateCompliance !== 'function') input.fail(503, 'Stored compliance delivery requires its reviewed contract.');
  return h.validateCompliance(db);
}

function authorize(db, auth, op, h, input) {
  authorizeActor(auth, op, input);
  if (auth.companyId !== db.company.id) input.fail(404, 'Subcontractor not found.');
  sources(db, input);
  const ledger = jobs(db, input, h);
  if (op.kind === 'subcontractorCreate') {
    if (db.subcontractors.some(row => !row.archivedAt && row.name.trim().toLowerCase() === op.details.name.toLowerCase())) input.fail(409, 'An active subcontractor with this company name already exists.');
    return;
  }
  const old = db.subcontractors.find(row => Number(row.id) === target(op));
  if (!old || op.kind === 'subcontractorCompliance' && old.id !== target(op)) input.fail(404, 'Subcontractor not found.');
  if (op.kind === 'subcontractorProfile' || op.kind === 'subcontractorArchive' && !op.details.archived) {
    const name = op.kind === 'subcontractorProfile' ? op.details.name ?? old.name.trim() : old.name.trim();
    if (db.subcontractors.some(row => Number(row.id) !== target(op) && !row.archivedAt && row.name.trim().toLowerCase() === name.toLowerCase())) input.fail(409, 'An active subcontractor with this company name already exists.');
  }
  if (ledger.some(row => Number(row.source.subcontractorId) === target(op) && ['sending', 'uncertain'].includes(row.status))) input.fail(409, 'Resolve the existing compliance reminder outcome before changing this subcontractor.');
  if (ledger.some(row => Number(row.source.subcontractorId) === target(op) && row.status === 'queued') && typeof h.cancelCompliance !== 'function') input.fail(503, 'Queued compliance delivery requires its reviewed cancellation contract.');
}

// Called on the clone after the actual named legacy handler and before delta
// validation. This only cancels existing queued jobs; it never stages/sends one.
function prepareCandidate(before, after, op, auth, h, input) {
  authorize(before, auth, op, h, input);
  if (op.kind !== 'subcontractorCreate' && jobs(before, input, h).some(row => Number(row.source.subcontractorId) === target(op) && row.status === 'queued')) h.cancelCompliance(after, target(op));
  return after;
}

function validateJobs(before, after, op, h, input) {
  const old = jobs(before, input, h), current = jobs(after, input, h);
  if (old.length !== current.length || Object.hasOwn(before, 'workspaceComplianceJobs') !== Object.hasOwn(after, 'workspaceComplianceJobs')) effectsFail(input);
  old.forEach((row, index) => {
    const actual = current[index], affected = op.kind !== 'subcontractorCreate' && Number(row.source.subcontractorId) === target(op);
    if (affected && ['sending', 'uncertain'].includes(row.status)) effectsFail(input);
    if (affected && row.status === 'queued') {
      if (!actual || actual.status !== 'cancelled' || !equal(omit(actual, ['status', 'proof']), omit(row, ['status', 'proof']))) effectsFail(input);
    } else if (!equal(actual, row)) effectsFail(input);
  });
}

function validate(before, after, op, auth, h, input) {
  authorize(before, auth, op, h, input);
  sources(after, input); validateJobs(before, after, op, h, input);
  const d = op.details, actor = auth.user.name || 'Office user', id = target(op);
  let expected, current, allowed = ['subcontractors', 'workspaceComplianceJobs'];
  const old = before.subcontractors.find(row => Number(row.id) === id);
  if (op.kind === 'subcontractorCreate') {
    current = after.subcontractors.at(-1);
    if (after.subcontractors.length !== before.subcontractors.length + 1 || !equal(after.subcontractors.slice(0, -1), before.subcontractors) || !iso(current?.complianceHistory?.[0]?.at)) effectsFail(input);
    expected = { id: Math.max(0, ...before.subcontractors.map(row => Number(row.id) || 0)) + 1, ...d, status: 'Active', archivedAt: null, complianceHistory: [{ action: 'Subcontractor added', detail: 'Added to the company subcontractor directory', by: actor, at: current.complianceHistory[0].at }] };
  } else {
    current = after.subcontractors.find(row => Number(row.id) === id);
    if (!current || after.subcontractors.length !== before.subcontractors.length || !equal(after.subcontractors.filter(row => Number(row.id) !== id), before.subcontractors.filter(row => Number(row.id) !== id)) || after.subcontractors.findIndex(row => Number(row.id) === id) !== before.subcontractors.findIndex(row => Number(row.id) === id)) effectsFail(input);
    expected = structuredClone(old); expected.complianceHistory ||= [];
    if (op.kind === 'subcontractorProfile' || op.kind === 'subcontractorCompliance') {
      Object.assign(expected, d);
      if (op.kind === 'subcontractorProfile') {
        expected.name = Object.hasOwn(d, 'name') ? d.name : String(old.name || '').trim();
        expected.email = Object.hasOwn(d, 'email') ? d.email : String(old.email || '').trim().toLowerCase();
      }
      const signature = row => ({ insuranceExpiration: row.insuranceExpiration || '', workersCompExpiration: row.workersCompExpiration || '', licenseNumber: row.licenseNumber || '', licenseExpiration: row.licenseExpiration || '', w9Received: Boolean(row.w9Received), agreementSigned: Boolean(row.agreementSigned), autoComplianceReminders: Boolean(row.autoComplianceReminders) });
      const changed = op.kind === 'subcontractorProfile' ? profile.filter(key => String(old[key] ?? '') !== String(expected[key] ?? '')) : equal(signature(old), signature(expected)) ? [] : ['compliance'];
      if (changed.length) {
        const at = current.complianceHistory?.at(-1)?.at;
        if (!iso(at)) effectsFail(input);
        expected.complianceHistory.push(op.kind === 'subcontractorProfile' ? { action: 'Subcontractor updated', detail: `Office reviewed ${changed.map(key => key.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}`, by: actor, at } : { action: 'Compliance updated', detail: 'Requirements and reminder settings reviewed by the office', at });
      }
      expected.complianceReminderStages = {};
    } else if (op.kind === 'subcontractorArchive') {
      allowed.push('subcontractorLinks');
      const historyIndex = (old.complianceHistory || []).length, at = current.complianceHistory?.[historyIndex]?.at;
      if (!iso(at)) effectsFail(input);
      Object.assign(expected, { archivedAt: d.archived ? at : null, archivedBy: d.archived ? actor : null, archiveReason: d.archived ? d.reason : '', status: d.archived ? 'Archived' : 'Active' });
      expected.complianceHistory.push({ action: d.archived ? 'Subcontractor archived' : 'Subcontractor restored', detail: d.archived ? d.reason : 'Returned to the active subcontractor directory', by: actor, at });
      const links = (before.subcontractorLinks || []).map(link => {
        if (!d.archived || Number(link.subcontractorId) !== id || link.status !== 'Active') return link;
        expected.complianceHistory.push({ action: 'Project access revoked', detail: `Access to ${before.projects.find(project => Number(project.id) === Number(link.projectId))?.name || 'project'} revoked during archive`, by: actor, at });
        return { ...link, status: 'Revoked', revokedAt: at, revokedBy: actor };
      });
      if (!equal(after.subcontractorLinks ?? [], links)) effectsFail(input);
    } else effectsFail(input);
  }
  if (!equal(current, expected) || !equal(omit(before, allowed), omit(after, allowed))) effectsFail(input);
  return { data: dto.subcontractor(current), retained: op.kind === 'subcontractorCreate' ? {} : { subcontractor: structuredClone(old), ...(op.kind === 'subcontractorArchive' ? { links: structuredClone((before.subcontractorLinks || []).filter(row => Number(row.subcontractorId) === id)) } : {}), ...(Object.hasOwn(before, 'workspaceComplianceJobs') ? { complianceJobs: structuredClone(before.workspaceComplianceJobs.filter(row => Number(row.source.subcontractorId) === id)) } : {}) } };
}

function currentResult(db, auth, receipt, first, h, input) {
  authorizeActor(auth, receipt.operation, input);
  if (auth.companyId !== db.company.id) input.fail(404, 'Subcontractor not found.');
  sources(db, input);
  const id = receipt.operation.kind === 'subcontractorCreate' ? Number(receipt.result.id) : target(receipt.operation);
  const visible = dto.bootstrap(db, auth.user, h).subcontractors.find(row => Number(row.id) === id);
  // Return current allowed contact/compliance DTO, never private stages,
  // history, guest secrets, old recipient values or a cached receipt body.
  return visible || { id, receiptId: receipt.id };
}

module.exports = { route, parse, authorizeActor, authorize, prepareCandidate, validate, currentResult };
