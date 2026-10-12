'use strict';
// Five existing template writers. These kinds are routes, never permission flags.
const { canonicalHash } = require('./database/transactional-repository');
const dto = require('./compat-workspace-projections');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const categories = ['daily', 'safety', 'inspection', 'quality', 'delivery', 'incident', 'custom'];
const types = ['text', 'longtext', 'number', 'yesno', 'dropdown', 'date', 'checkbox'];
const core = new Set(['job', 'date', 'laborentries', 'productionentries', 'status', 'labor', 'quantity', 'hours']);
const safetyNotice = 'Company review required. This form supports the company safety program and does not certify regulatory compliance.';
const slug = value => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const coreKey = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const names = ['name', 'fields', 'category', 'description', 'requirements', 'assignment', 'reviewNotice'];
function key(value, input) {
  if (value === 'standard') return value;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!input.id(number)) input.fail(400, 'Choose a current template ID.');
  return String(number);
}
function route(method, path) {
  if (method === 'POST' && path === '/api/daily-templates') return 'templateCreate';
  if (method === 'POST' && path === '/api/daily-templates/default') return 'templateDefault';
  if (method === 'PATCH' && /^\/api\/projects\/[1-9]\d*\/template$/.test(path)) return 'projectTemplates';
  if (['PATCH', 'DELETE'].includes(method) && /^\/api\/daily-templates\/(?:standard|[1-9]\d*)$/.test(path)) return method === 'PATCH' ? 'templateEdit' : 'templateRemove';
  return null;
}
function boolean(value, input) {
  if (typeof value !== 'boolean') input.fail(400, 'Choose an explicit template requirement.');
  return value;
}
function strings(value, input) {
  if (!Array.isArray(value) || value.length > 30) input.fail(400, 'Choose up to 30 template assignment labels.');
  const out = value.map(value => input.text(value, 120, true));
  if (new Set(out).size !== out.length) input.fail(400, 'Template assignment labels must be unique.');
  return out;
}
function fields(value, input) {
  if (!Array.isArray(value) || value.length > 40) input.fail(400, 'Choose up to 40 supported template fields.');
  const used = new Set();
  const out = value.map(raw => {
    if (!input.object(raw, ['id', 'label', 'type', 'required', 'help', 'options', 'showWhen'])) input.fail(400, 'Only declared template field properties are accepted.');
    const label = input.text(raw.label, 80, true), type = raw.type;
    if (!types.includes(type)) input.fail(400, 'Choose a supported template answer type.');
    const id = slug(Object.hasOwn(raw, 'id') ? input.text(raw.id, 80, true) : label);
    if (!id || used.has(id) || core.has(coreKey(id)) || core.has(coreKey(label))) input.fail(400, 'Custom fields cannot duplicate or replace fixed daily fields.');
    used.add(id);
    const field = { id, label, type, required: Object.hasOwn(raw, 'required') ? boolean(raw.required, input) : false, help: Object.hasOwn(raw, 'help') ? input.text(raw.help, 180) : '' };
    if (type === 'dropdown') {
      const options = typeof raw.options === 'string' ? input.text(raw.options, 4020).split(',').map(value => value.trim()).filter(Boolean) : raw.options;
      if (!Array.isArray(options) || options.length < 2 || options.length > 20) input.fail(400, 'A dropdown needs two to 20 choices.');
      field.options = options.map(value => input.text(value, 200, true));
      if (new Set(field.options).size !== field.options.length) input.fail(400, 'Dropdown choices must be unique.');
    } else if (Object.hasOwn(raw, 'options') && raw.options !== '' && (!Array.isArray(raw.options) || raw.options.length)) input.fail(400, 'Only dropdown fields have choices.');
    if (Object.hasOwn(raw, 'showWhen')) {
      if (!input.object(raw.showWhen, ['fieldId', 'value']) || Object.keys(raw.showWhen).length !== 2 || !['yes', 'no', 'checked'].includes(raw.showWhen.value)) input.fail(400, 'Choose a declared conditional field.');
      field.showWhen = { fieldId: slug(input.text(raw.showWhen.fieldId, 80, true)), value: raw.showWhen.value };
    }
    return field;
  });
  for (const field of out.filter(row => row.showWhen)) {
    const source = out.find(row => row.id === field.showWhen.fieldId);
    if (!source || source.id === field.id || source.type !== (field.showWhen.value === 'checked' ? 'checkbox' : 'yesno')) input.fail(400, 'Conditional fields must reference another declared yes/no or checkbox field.');
    const visited = new Set([field.id]); let current = source;
    while (current?.showWhen) {
      if (visited.has(current.id)) input.fail(400, 'Conditional fields cannot contain a cycle.');
      visited.add(current.id); current = out.find(row => row.id === current.showWhen.fieldId);
    }
  }
  return out;
}
function parse(op, input) {
  if (!input.object(op, ['kind', 'method', 'path', 'details']) || Object.keys(op).length !== 4 || typeof op.path !== 'string' || op.path.length > 160 || !op.kind || route(op.method, op.path) !== op.kind) input.fail(400, 'Choose one supported template change.');
  if (op.kind === 'projectTemplates' && !input.id(Number(op.path.split('/')[3]))) input.fail(400, 'Choose a current project ID.');
  if (op.kind === 'templateEdit' || op.kind === 'templateRemove') key(op.path.split('/')[3], input);
  const d = op.details; let out = {};
  if (op.kind === 'templateCreate' || op.kind === 'templateEdit') {
    if (!input.object(d, names)) input.fail(400, 'Template identity and history are generated by the server.');
    for (const [name, limit] of [['name', 80], ['description', 400], ['reviewNotice', 240]]) if (Object.hasOwn(d, name)) out[name] = input.text(d[name], limit, name === 'name');
    if (op.kind === 'templateCreate' && !Object.hasOwn(out, 'name')) input.fail(400, 'Template name is required.');
    if (Object.hasOwn(d, 'category')) { if (!categories.includes(d.category)) input.fail(400, 'Choose a supported template category.'); out.category = d.category; }
    if (Object.hasOwn(d, 'fields')) out.fields = fields(d.fields, input);
    else if (op.kind === 'templateCreate') out.fields = [];
    if (Object.hasOwn(d, 'requirements')) {
      if (!input.object(d.requirements, ['photo', 'signature', 'acknowledgement'])) input.fail(400, 'Choose the three supported template requirements.');
      out.requirements = Object.fromEntries(['photo', 'signature', 'acknowledgement'].map(name => [name, Object.hasOwn(d.requirements, name) ? boolean(d.requirements[name], input) : false]));
    }
    if (Object.hasOwn(d, 'assignment')) {
      if (!input.object(d.assignment, ['crewNames', 'workTypes'])) input.fail(400, 'Only crew and work type labels are accepted.');
      out.assignment = { crewNames: strings(d.assignment.crewNames ?? [], input), workTypes: strings(d.assignment.workTypes ?? [], input) };
    }
    if (out.category === 'safety') out.reviewNotice = safetyNotice;
  } else if (op.kind === 'templateDefault') {
    if (!input.object(d, ['templateId']) || Object.keys(d).length !== 1) input.fail(400, 'Choose only the current default template.');
    out = { templateId: key(d.templateId, input) };
  } else if (op.kind === 'projectTemplates') {
    if (!input.object(d, ['templateId', 'templateIds']) || Object.keys(d).length !== 1) input.fail(400, 'Choose the current project templates.');
    const values = Object.hasOwn(d, 'templateIds') ? d.templateIds : [d.templateId];
    if (!Array.isArray(values) || values.length > 1000) input.fail(400, 'Choose a bounded list of project templates.');
    const ids = values.map(value => key(value, input));
    if (new Set(ids).size !== ids.length) input.fail(400, 'Project templates must be unique.');
    out = { templateIds: ids.length ? ids : ['standard'] };
  } else if (!input.object(d, []) || Object.keys(d).length) input.fail(400, 'Template removal accepts no record properties.');
  return { kind: op.kind, method: op.method, path: op.path, details: out };
}
function authorizeActor(auth, op, input) {
  if (!auth?.user || auth.user.status !== 'Active' || !['owner', 'admin'].includes(auth.user.role)) input.fail(403, 'Current Owner or Admin template permission required.');
}
function standard() { return { id: 'standard', name: 'Standard', category: 'daily', description: 'The standard production daily report.', locked: true, requirements: { photo: false, signature: false, acknowledgement: false }, assignment: { crewNames: [], workTypes: [] }, versions: [{ version: 1, fields: [], createdAt: null, createdBy: null }] }; }
function find(db, id) { return String(id) === 'standard' ? standard() : (db.dailyTemplates || []).find(row => String(row.id) === String(id)); }
function inUse(db, id) {
  const key = String(id);
  return String(db.company.defaultTemplateId) === key || (db.projects || []).some(row => String(row.templateId) === key || (row.templateIds || []).some(id => String(id) === key)) || (db.reports || []).some(row => String(row.templateId) === key);
}
function sourceTemplate(row, input) {
  if (!row || !Array.isArray(row.versions) || !row.versions.length || row.versions.length > 10000) input.fail(409, 'Template version history requires reconciliation.');
  try {
    key(row.id, input); input.text(row.name, 80, true);
    if (Object.hasOwn(row, 'locked')) boolean(row.locked, input);
    if (Object.hasOwn(row, 'category') && !categories.includes(row.category)) input.fail(400, 'Unsupported source category.');
    for (const [name, limit] of [['description', 400], ['reviewNotice', 240]]) if (Object.hasOwn(row, name)) input.text(row[name], limit);
    if (Object.hasOwn(row, 'requirements')) {
      if (!input.object(row.requirements, ['photo', 'signature', 'acknowledgement'])) input.fail(400, 'Unsupported source requirements.');
      for (const value of Object.values(row.requirements)) boolean(value, input);
    }
    if (Object.hasOwn(row, 'assignment')) {
      if (!input.object(row.assignment, ['crewNames', 'workTypes'])) input.fail(400, 'Unsupported source assignment.');
      for (const labels of Object.values(row.assignment)) strings(labels, input);
    }
    for (const [index, version] of row.versions.entries()) {
      if (!version || !input.id(version.version) || version.version !== index + 1 || !equal(fields(version.fields, input), version.fields)) input.fail(400, 'Unsupported source field history.');
      if (Object.hasOwn(version, 'name')) input.text(version.name, 80, true);
      if (row.id !== 'standard' && (!iso(version.createdAt) || typeof version.createdBy !== 'string')) input.fail(400, 'Unsupported source version attribution.');
      if (typeof version.createdBy === 'string') input.text(version.createdBy, 160, true);
    }
  } catch (error) {
    if (error.statusCode === 400) input.fail(409, 'Template source requires reconciliation.');
    throw error;
  }
  return row;
}
function authorize(db, auth, op, h, input) {
  authorizeActor(auth, op, input);
  if (auth.user.companyId != null && auth.user.companyId !== db.company.id) input.fail(403, 'Current company template permission required.');
  if (db.company.features?.templates !== true) input.fail(404, 'Not found');
  if (!Array.isArray(db.dailyTemplates || []) || (db.dailyTemplates || []).some(row => !row || row.companyId != null && row.companyId !== db.company.id) || new Set((db.dailyTemplates || []).map(row => String(row.id))).size !== (db.dailyTemplates || []).length) input.fail(409, 'Template library requires reconciliation.');
  if (['templateEdit', 'templateRemove'].includes(op.kind)) {
    const id = op.path.split('/')[3]; if (id === 'standard') input.fail(409, 'Standard is locked.');
    const row = find(db, id); if (!row) input.fail(404, 'Template not found.'); sourceTemplate(row, input);
    if (row.locked === true) input.fail(409, 'Locked templates require reconciliation.');
    if (op.kind === 'templateEdit' && row.versions.length >= 10000) input.fail(409, 'Template version capacity requires reconciliation.');
    if (op.kind === 'templateRemove' && inUse(db, row.id)) input.fail(409, 'This template is still used by a project, a daily, or the company default.');
  }
  if (op.kind === 'templateDefault' || op.kind === 'projectTemplates') {
    for (const id of op.kind === 'templateDefault' ? [op.details.templateId] : op.details.templateIds) {
      const row = find(db, id); if (!row) input.fail(404, 'Template not found.'); sourceTemplate(row, input);
    }
  }
  if (op.kind === 'projectTemplates' && !(db.projects || []).some(row => row.id === Number(op.path.split('/')[3]))) input.fail(404, 'Project not found.');
}
function meta(d, existing = {}) {
  const category = d.category || existing.category || 'daily', requirements = d.requirements || existing.requirements || {}, assignment = d.assignment || existing.assignment || {};
  return { category, description: String(d.description ?? existing.description ?? '').trim().slice(0, 400), requirements: { photo: requirements.photo === true, signature: requirements.signature === true, acknowledgement: requirements.acknowledgement === true }, assignment: { crewNames: [...new Set((assignment.crewNames || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 30), workTypes: [...new Set((assignment.workTypes || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 30) }, reviewNotice: category === 'safety' ? safetyNotice : String(d.reviewNotice ?? existing.reviewNotice ?? '').trim().slice(0, 240) };
}
function validate(before, after, op, auth, h, input) {
  authorize(before, auth, op, h, input); authorizeActor(auth, op, input);
  const fail = () => input.fail(409, 'Template effects require reconciliation.'), d = op.details;
  let allowed, data, retained = {};
  if (['templateCreate', 'templateEdit', 'templateRemove'].includes(op.kind)) {
    allowed = ['dailyTemplates']; const rows = before.dailyTemplates || [], changed = after.dailyTemplates;
    if (!Array.isArray(changed)) fail();
    if (op.kind === 'templateCreate') {
      const row = changed.at(-1), expectedId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
      if (!input.id(expectedId) || changed.length !== rows.length + 1 || !equal(changed.slice(0, -1), rows) || !row) fail();
      const version = row.versions?.[0], expected = { id: expectedId, name: d.name, locked: false, ...meta(d), versions: [{ version: 1, name: d.name, fields: d.fields, createdAt: version?.createdAt, createdBy: auth.user.name || 'Office' }] };
      if (!iso(version?.createdAt) || !equal(row, expected)) fail();
      sourceTemplate(row, input); data = dto.template(row);
    } else {
      const old = find(before, op.path.split('/')[3]); retained = { template: structuredClone(old) };
      if (op.kind === 'templateRemove') {
        if (!equal(changed, rows.filter(row => row.id !== old.id))) fail(); data = { ok: true, id: old.id };
      } else {
        const row = changed.find(row => row.id === old.id), version = row?.versions?.at(-1), name = d.name || old.name, expected = { ...old, name, ...meta(d, old), versions: [...old.versions, { version: old.versions.at(-1).version + 1, name, fields: d.fields || old.versions.at(-1).fields, createdAt: version?.createdAt, createdBy: auth.user.name || 'Office' }] };
        if (!iso(version?.createdAt) || !equal(row, expected) || !equal(changed.filter(row => row.id !== old.id), rows.filter(row => row.id !== old.id))) fail();
        sourceTemplate(row, input); data = dto.template(row);
      }
    }
  } else if (op.kind === 'templateDefault') {
    allowed = ['company']; const template = find(before, d.templateId);
    if (!equal(after.company, { ...before.company, defaultTemplateId: template.id })) fail();
    retained = { defaultTemplateId: Object.hasOwn(before.company, 'defaultTemplateId') ? { present: true, value: structuredClone(before.company.defaultTemplateId) } : { present: false } };
    data = { defaultTemplateId: template.id };
  } else if (op.kind === 'projectTemplates') {
    allowed = ['projects']; const id = Number(op.path.split('/')[3]), old = before.projects.find(row => row.id === id), row = after.projects.find(row => row.id === id), template = find(before, d.templateIds[0]);
    const expected = { ...old, templateIds: [...d.templateIds], templateId: template.id, templateVersion: template.versions.at(-1).version };
    if (!equal(row, expected) || !equal(after.projects.filter(row => row.id !== id), before.projects.filter(row => row.id !== id))) fail();
    retained = { project: structuredClone(old) }; data = { id, templateId: row.templateId, templateVersion: row.templateVersion, templateIds: [...row.templateIds] };
  } else fail();
  if (!equal(omit(before, allowed), omit(after, allowed))) fail();
  return { data, retained };
}
function currentResult(db, auth, receipt, first, h, input) {
  const op = receipt.operation; authorizeActor(auth, op, input);
  if (auth.user.companyId != null && auth.user.companyId !== db.company.id) input.fail(403, 'Current company template permission required.');
  if (db.company.features?.templates !== true) input.fail(404, 'Not found');
  const technical = { receiptId: receipt.id };
  if (op.kind === 'templateRemove') return { ok: true, id: receipt.result.id, ...technical };
  if (['templateCreate', 'templateEdit'].includes(op.kind)) {
    const id = receipt.result.id, row = find(db, id);
    // The first version is immutable lifecycle identity. Recycled numeric IDs
    // acknowledge the old save only; they never identify a replacement record.
    if (!row || !equal(row.versions?.[0], receipt.result.versions?.[0])) return { id, ...technical };
    sourceTemplate(row, input); return { ...dto.template(row), ...technical };
  }
  if (op.kind === 'templateDefault') {
    const row = find(db, db.company.defaultTemplateId || 'standard');
    if (!row) input.fail(409, 'Current default template requires reconciliation.'); sourceTemplate(row, input);
    return { defaultTemplateId: row.id, ...technical };
  }
  if (op.kind === 'projectTemplates') {
    const id = Number(op.path.split('/')[3]), row = (db.projects || []).find(row => row.id === id), old = receipt.retained?.project;
    // Projects have no immutable lifecycle key. A replay cannot identify a
    // replacement project at the same numeric ID; callers reload current views.
    if (!first || !row || !old || !equal(omit(row, ['templateId', 'templateVersion', 'templateIds']), omit(old, ['templateId', 'templateVersion', 'templateIds']))) return { id, ...technical };
    if (!input.id(row.templateVersion) || !Array.isArray(row.templateIds) || row.templateIds.length > 1000 || !equal(row.templateIds.map(id => key(id, input)), row.templateIds)) input.fail(409, 'Current project template binding requires reconciliation.');
    for (const id of row.templateIds) { const template = find(db, id); if (!template) input.fail(409, 'Current project template binding requires reconciliation.'); sourceTemplate(template, input); }
    const primary = find(db, row.templateId);
    if (!primary || String(row.templateId) !== row.templateIds[0] || !primary.versions.some(version => version.version === row.templateVersion)) input.fail(409, 'Current project template binding requires reconciliation.');
    return { id, templateId: find(db, row.templateId)?.id ?? row.templateId, templateVersion: row.templateVersion, templateIds: [...row.templateIds], ...technical };
  }
  input.fail(409, 'Current template readback requires review.');
}
module.exports = { route, parse, authorizeActor, authorize, validate, currentResult };
