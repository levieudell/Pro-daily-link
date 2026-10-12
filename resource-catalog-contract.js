'use strict';
// Four exact existing writers. These operation names are not permission flags.
const { canonicalHash } = require('./database/transactional-repository');
const dto = require('./compat-workspace-projections');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (value, names) => Object.fromEntries(Object.entries(value).filter(([name]) => !names.includes(name)));
const source = (input, message = 'Catalog or contract effects require reconciliation.') => input.fail(409, message);
const nextId = rows => Math.max(0, ...rows.map(row => Number(row.id) || 0)) + 1;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const defaults = () => require('./resource-inputs');

function route(method, path) {
  if (method === 'POST' && path === '/api/catalog') return 'catalogCreate';
  if (method === 'POST' && /^\/api\/catalog\/[1-9]\d*\/apply$/.test(path)) return 'catalogApply';
  if (['PATCH', 'PUT'].includes(method) && /^\/api\/projects\/[1-9]\d*$/.test(path)) return 'projectContract';
  return null;
}

function parse(value, input = defaults()) {
  if (!input.object(value, ['kind', 'method', 'path', 'details']) || Object.keys(value).length !== 4 || typeof value.path !== 'string' || value.path.length > 160 || !value.kind || route(value.method, value.path) !== value.kind) input.fail(400, 'Choose one supported catalog or contract change.');
  const d = value.details;
  let details;
  if (value.kind === 'catalogCreate') {
    if (!input.object(d, ['name', 'category', 'unit', 'targetHoursPerUnit', 'description'])) input.fail(400, 'Use only the existing catalog details.');
    details = {
      name: input.text(d.name, 120, true),
      category: Object.hasOwn(d, 'category') ? input.text(d.category, 120) || 'General' : 'General',
      unit: input.text(d.unit, 20, true).toUpperCase(),
      targetHoursPerUnit: Object.hasOwn(d, 'targetHoursPerUnit') ? input.number(d.targetHoursPerUnit) : 0,
      description: Object.hasOwn(d, 'description') ? input.text(d.description, 500) : ''
    };
  } else if (value.kind === 'catalogApply') {
    if (!input.object(d, ['projectId', 'plannedQuantity']) || Object.keys(d).length !== 2 || !input.id(d.projectId) || !input.id(Number(value.path.split('/')[3]))) input.fail(400, 'Choose a current catalog item and project.');
    const plannedQuantity = input.number(d.plannedQuantity);
    if (plannedQuantity <= 0) input.fail(400, 'Planned quantity must be greater than zero.');
    details = { projectId: d.projectId, plannedQuantity };
  } else {
    if (!input.object(d, ['contractValue']) || Object.keys(d).length !== 1 || !input.id(Number(value.path.split('/')[3]))) input.fail(400, 'Only contract value may change through this operation.');
    details = { contractValue: input.number(d.contractValue) };
  }
  return { kind: value.kind, method: value.method, path: value.path, details };
}

function authorizeActor(auth, op, input = defaults()) {
  const user = auth?.user;
  const roles = op.kind === 'projectContract' ? ['owner', 'admin'] : ['owner', 'admin', 'project_manager'];
  if (!user || user.status !== 'Active' || !roles.includes(user.role)) input.fail(403, op.kind === 'projectContract' ? 'Current Owner or Admin permission required.' : 'Current Office permission required.');
}

function identities(rows, input) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !input.id(row.id)) || new Set(rows.map(row => row.id)).size !== rows.length || !input.id(nextId(rows))) source(input);
  return rows;
}
function projectId(op) { return op.kind === 'catalogApply' ? op.details.projectId : Number(op.path.split('/')[3]); }
function projectScope(db, auth, op, h, input) {
  const project = (db.projects || []).find(row => row.id === projectId(op));
  if (!project) input.fail(404, 'Project not found.');
  if (auth.user.role === 'project_manager') {
    if (typeof h.canAccessProject !== 'function') input.fail(503, 'Current project scope helper required.');
    if (!h.canAccessProject(db, auth.user, project.id)) input.fail(404, 'Project not found.');
  }
  return project;
}
function catalogRow(row, input) {
  if (!row || !input.id(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || typeof row.unit !== 'string' || !row.unit.trim() || row.unit.length > 20 || typeof row.targetHoursPerUnit !== 'number' || !Number.isFinite(row.targetHoursPerUnit) || row.targetHoursPerUnit < 0 || row.targetHoursPerUnit > 1e12) source(input, 'Current catalog item needs reconciliation.');
  return row;
}
function budget(item, quantity, input) {
  const hours = Math.round(quantity * item.targetHoursPerUnit * 100) / 100;
  if (!Number.isFinite(hours) || hours < 0 || hours > 1e12) input.fail(400, 'The resulting labor budget exceeds the supported range.');
  return hours;
}
function authorize(db, auth, op, h, input = defaults()) {
  authorizeActor(auth, op, input);
  if (op.kind === 'catalogCreate') identities(db.catalog || [], input);
  if (op.kind === 'catalogApply') {
    const item = identities(db.catalog || [], input).find(row => row.id === Number(op.path.split('/')[3]));
    if (!item) input.fail(404, 'Catalog item not found.');
    catalogRow(item, input);
    const project = projectScope(db, auth, op, h, input);
    identities(project.estimateItems || [], input);
    budget(item, op.details.plannedQuantity, input);
  }
  if (op.kind === 'projectContract') {
    projectScope(db, auth, op, h, input);
    if (typeof h.canViewPricing !== 'function' || !h.canViewPricing(db, auth.user)) input.fail(403, 'Existing pricing access required.');
    // The legacy PATCH already has this gate. PUT must not bypass it.
    if (db.company.contractValueTracking !== true) input.fail(409, 'Turn on contract value tracking before adding project pricing.');
  }
}
function catalogDTO(row) { return dto.pick(row, ['id', 'name', 'category', 'unit', 'targetHoursPerUnit', 'description', 'createdAt']); }
function estimateDTO(row) { return dto.pick(row, ['id', 'catalogItemId', 'name', 'plannedQuantity', 'unit', 'budgetHours', 'cost']); }

function validate(before, after, op, auth, h, input = defaults()) {
  authorize(before, auth, op, h, input);
  let data, retained, allowed;
  if (op.kind === 'catalogCreate') {
    const old = before.catalog || [], rows = after.catalog;
    if (!Array.isArray(rows) || rows.length !== old.length + 1 || !equal(rows.slice(0, -1), old)) source(input);
    const row = rows.at(-1);
    if (!row || !iso(row.createdAt) || !equal(omit(row, ['createdAt']), { id: nextId(old), ...op.details })) source(input);
    data = catalogDTO(row); retained = {}; allowed = ['catalog'];
  } else {
    const id = projectId(op), old = before.projects.find(row => row.id === id), row = after.projects?.find(row => row.id === id);
    if (!row || !equal(after.projects, before.projects.map(value => value.id === id ? row : value))) source(input);
    if (op.kind === 'catalogApply') {
      const item = before.catalog.find(row => row.id === Number(op.path.split('/')[3])), oldItems = old.estimateItems || [], items = row.estimateItems;
      const expected = { id: nextId(oldItems), catalogItemId: item.id, name: item.name, plannedQuantity: op.details.plannedQuantity, unit: item.unit, budgetHours: budget(item, op.details.plannedQuantity, input), cost: 0 };
      if (!Array.isArray(items) || items.length !== oldItems.length + 1 || !equal(items.slice(0, -1), oldItems) || !equal(items.at(-1), expected) || !equal(omit(row, ['estimateItems']), omit(old, ['estimateItems']))) source(input);
      data = estimateDTO(items.at(-1));
      if (!h.canViewPricing(after, auth.user)) delete data.cost;
    } else {
      const contractValue = op.details.contractValue, formatted = '$' + contractValue.toLocaleString('en-US', { maximumFractionDigits: 2 });
      if (!equal(row, { ...old, contractValue, budget: formatted })) source(input);
      data = dto.project(row, true);
    }
    retained = { project: structuredClone(old) }; allowed = ['projects'];
  }
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => !equal(before[name], after[name]));
  if (changed.some(name => !allowed.includes(name))) source(input);
  return { data, retained };
}

function currentResult(db, auth, receipt, first, h, input = defaults()) {
  const op = receipt.operation;
  authorizeActor(auth, op, input);
  const technical = { id: receipt.result.id, receiptId: receipt.id };
  if (op.kind === 'catalogCreate') {
    const current = (db.catalog || []).find(row => row.id === receipt.result.id && row.createdAt === receipt.result.createdAt);
    return current ? catalogDTO(current) : technical;
  }
  const project = (db.projects || []).find(row => row.id === projectId(op));
  if (!project) return technical;
  if (auth.user.role === 'project_manager') {
    if (typeof h.canAccessProject !== 'function') input.fail(503, 'Current project scope helper required.');
    if (!h.canAccessProject(db, auth.user, project.id)) return technical;
  }
  if (op.kind === 'catalogApply') {
    const current = (project.estimateItems || []).find(row => row.id === receipt.result.id && row.catalogItemId === receipt.result.catalogItemId);
    if (!current) return technical;
    const result = estimateDTO(current);
    if (!h.canViewPricing(db, auth.user)) delete result.cost;
    return result;
  }
  if (db.company.contractValueTracking !== true || !h.canViewPricing(db, auth.user)) return technical;
  return dto.project(project, true);
}

module.exports = { route, parse, authorizeActor, authorize, validate, currentResult };
