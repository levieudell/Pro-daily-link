'use strict';
// Eight exact existing manual estimate writers. Kinds are operation identities,
// never editable controls. PDF creation and provider/file effects are excluded.
const { canonicalHash } = require('./database/transactional-repository');
const dto = require('./compat-workspace-projections');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const defaults = () => require('./resource-inputs');
const source = input => input.fail(409, 'Estimate source or effects need reconciliation.');
const nextId = rows => Math.max(0, ...rows.map(row => Number(row.id) || 0)) + 1;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const roles = ['owner', 'admin', 'project_manager', 'foreman', 'field'];

function route(method, path) {
  if (method === 'POST' && /^\/api\/projects\/[1-9]\d*\/estimate-items$/.test(path)) return 'estimateItemCreate';
  if (['PATCH', 'PUT', 'DELETE'].includes(method) && /^\/api\/projects\/[1-9]\d*\/estimate-items\/[1-9]\d*$/.test(path)) return method === 'DELETE' ? 'estimateItemRemove' : 'estimateItemEdit';
  if (method === 'POST' && /^\/api\/projects\/[1-9]\d*\/estimate-proposals$/.test(path)) return 'estimateProposalCreate';
  if (method === 'POST' && /^\/api\/projects\/[1-9]\d*\/estimate-proposals\/[1-9]\d*\/approve$/.test(path)) return 'estimateProposalApprove';
  if (method === 'PATCH' && /^\/api\/estimate-imports\/[1-9]\d*\/draft$/.test(path)) return 'estimateImportDraft';
  if (method === 'POST' && /^\/api\/estimate-imports\/[1-9]\d*\/approve$/.test(path)) return 'estimateImportApprove';
  return null;
}
function number(value, input, nullable = false) {
  if (nullable && (value === null || typeof value === 'string' && !value.trim())) return null;
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) input.fail(400, 'Use finite estimate numbers or explicit blank values.');
  return input.number(Number(value));
}
function line(raw, draft, input) {
  const keys = draft ? ['description', 'unit', 'quantity', 'amount', 'budgetHours', 'unitPrice', 'internalCost', 'catalogItemId', 'scopeStatus', 'budgetHoursUserEdited'] : ['description', 'unit', 'quantity', 'amount', 'budgetHours', 'catalogItemId'];
  if (!input.object(raw, keys)) input.fail(400, 'Use only reviewed estimate line fields.');
  const out = { description: input.text(raw.description, 500, !draft), unit: input.text(raw.unit, 20, !draft), quantity: Object.hasOwn(raw, 'quantity') ? number(raw.quantity, input, draft) : draft ? null : undefined };
  if (!draft && !(out.quantity > 0)) input.fail(400, 'Confirmed lines need a positive quantity and unit.');
  for (const key of draft ? ['amount', 'budgetHours', 'unitPrice', 'internalCost'] : ['amount', 'budgetHours']) if (Object.hasOwn(raw, key)) out[key] = number(raw[key], input, true);
  if (Object.hasOwn(raw, 'catalogItemId')) { if (raw.catalogItemId !== null && !input.id(raw.catalogItemId)) input.fail(400, 'Choose a current catalog item.'); out.catalogItemId = raw.catalogItemId; }
  if (draft) {
    if (Object.hasOwn(raw, 'scopeStatus') && !['uncertain', 'included'].includes(raw.scopeStatus)) input.fail(400, 'Choose the existing included or uncertain scope.');
    if (Object.hasOwn(raw, 'budgetHoursUserEdited') && typeof raw.budgetHoursUserEdited !== 'boolean') input.fail(400, 'Use an explicit budget review choice.');
    if (Object.hasOwn(raw, 'scopeStatus')) out.scopeStatus = raw.scopeStatus;
    if (Object.hasOwn(raw, 'budgetHoursUserEdited')) out.budgetHoursUserEdited = raw.budgetHoursUserEdited;
  }
  return out;
}
function parse(op, input = defaults()) {
  if (!input.object(op, ['kind', 'method', 'path', 'details']) || Object.keys(op).length !== 4 || typeof op.path !== 'string' || op.path.length > 160 || !op.kind || route(op.method, op.path) !== op.kind || op.path.split('/').filter(value => /^[1-9]\d*$/.test(value)).some(value => !input.id(Number(value)))) input.fail(400, 'Choose one supported manual estimate change.');
  const d = op.details; let details = {};
  if (op.kind === 'estimateItemCreate' || op.kind === 'estimateItemEdit') {
    const keys = ['name', 'plannedQuantity', 'unit', 'budgetHours', 'cost'];
    if (!input.object(d, keys) || op.kind === 'estimateItemEdit' && !Object.keys(d).length) input.fail(400, 'Use only the manual estimate item fields.');
    if (Object.hasOwn(d, 'name') || op.kind === 'estimateItemCreate') details.name = input.text(d.name, 120, true);
    if (Object.hasOwn(d, 'plannedQuantity') || op.kind === 'estimateItemCreate') { details.plannedQuantity = number(d.plannedQuantity, input); if (!(details.plannedQuantity > 0)) input.fail(400, 'Planned quantity must be positive.'); }
    if (Object.hasOwn(d, 'unit')) details.unit = input.text(d.unit, 10) || 'EA';
    if (Object.hasOwn(d, 'budgetHours')) details.budgetHours = number(d.budgetHours, input, true);
    if (Object.hasOwn(d, 'cost')) details.cost = number(d.cost, input);
  } else if (op.kind === 'estimateProposalCreate') {
    if (!input.object(d, ['name', 'plannedQuantity', 'unit'])) input.fail(400, 'Use a manual scope line; PDF/provider effects require a separate contract.');
    const quantity = number(d.plannedQuantity, input); if (!(quantity > 0)) input.fail(400, 'Planned quantity must be positive.');
    details = { name: input.text(d.name, 120, true), plannedQuantity: quantity, unit: Object.hasOwn(d, 'unit') ? input.text(d.unit, 10).toUpperCase() || 'EA' : 'EA' };
  } else if (op.kind === 'estimateImportDraft' || op.kind === 'estimateImportApprove') {
    if (!input.object(d, ['projectId', 'lines']) || Object.keys(d).length !== 2 || !input.id(d.projectId) || !Array.isArray(d.lines) || d.lines.length > 500 || op.kind === 'estimateImportApprove' && !d.lines.length) input.fail(400, 'Choose a current project and bounded reviewed lines.');
    details = { projectId: d.projectId, lines: d.lines.map(row => line(row, op.kind === 'estimateImportDraft', input)) };
  } else if (!input.object(d, []) || Object.keys(d).length) input.fail(400, 'This estimate operation accepts no source overrides.');
  return { kind: op.kind, method: op.method, path: op.path, details };
}
function authorizeActor(auth, op, input = defaults()) {
  const user = auth?.user, ceiling = ['estimateItemCreate', 'estimateProposalCreate'].includes(op.kind) ? roles : ['estimateItemEdit', 'estimateItemRemove'].includes(op.kind) ? ['owner', 'admin'] : ['owner', 'admin', 'project_manager'];
  if (!user || user.status !== 'Active' || !ceiling.includes(user.role)) input.fail(403, 'Current estimate management permission required.');
}
function rows(value, db, input) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !input.id(row.id) || row.companyId !== undefined && row.companyId !== db.company.id) || new Set(value.map(row => row.id)).size !== value.length || !input.id(nextId(value))) source(input);
  return value;
}
function projectId(op) { return op.kind.startsWith('estimateImport') ? op.details.projectId : Number(op.path.split('/')[3]); }
function scope(db, auth, id, h, input) {
  const project = rows(db.projects, db, input).find(row => row.id === id);
  if (!project) input.fail(404, 'Project not found.');
  if (typeof h.canAccessProject !== 'function') input.fail(503, 'Existing project scope helper required.');
  if (!h.canAccessProject(db, auth.user, id)) input.fail(404, 'Project not found.');
  return project;
}
function pricing(db, user, h, input) {
  if (typeof h.canViewPricing !== 'function') input.fail(503, 'Existing pricing helper required.');
  const policy = db.company.pricingAccess;
  if (policy !== undefined && (!input.object(policy, ['enabled', 'officeMode', 'userIds']) || Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean' || Object.hasOwn(policy, 'officeMode') && !['all', 'selected'].includes(policy.officeMode) || Object.hasOwn(policy, 'userIds') && (!Array.isArray(policy.userIds) || policy.userIds.some(value => !input.id(value)) || new Set(policy.userIds).size !== policy.userIds.length))) source(input);
  return h.canViewPricing(db, user);
}
function itemSource(row, input) {
  if (!row || typeof row.name !== 'string' || !row.name.trim() || typeof row.unit !== 'string' || !row.unit.trim() || !['number', 'string'].includes(typeof row.plannedQuantity) || !Number.isFinite(Number(row.plannedQuantity)) || !(Number(row.plannedQuantity) > 0)) source(input);
  for (const key of ['budgetHours', 'cost']) if (Object.hasOwn(row, key) && row[key] !== null && (!['number', 'string'].includes(typeof row[key]) || String(row[key]).trim() === '' || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0 || Number(row[key]) > 1e12)) source(input);
}
function imports(db, op, auth, h, input) {
  const imported = rows(db.estimateImports, db, input).find(row => row.id === Number(op.path.split('/')[3]));
  if (!imported) input.fail(404, 'Import not found.');
  if (!['Draft', 'Approved'].includes(imported.status) || !input.id(imported.createdByUserId) || !iso(imported.createdAt) || imported.projectId !== undefined && imported.projectId !== null && !input.id(imported.projectId)) source(input);
  if (imported.status === 'Approved') input.fail(409, 'This import was already approved.');
  if (imported.projectId != null) scope(db, auth, imported.projectId, h, input);
  else if (auth.user.role === 'project_manager' && imported.createdByUserId !== auth.user.id) input.fail(404, 'Import not found.');
  return imported;
}
function catalog(db, lines, input) {
  const values = rows(db.catalog, db, input);
  for (const row of values) if (Object.keys(row).some(key => !['id', 'companyId', 'name', 'unit', 'targetHoursPerUnit', 'category', 'description', 'createdAt'].includes(key)) || typeof row.name !== 'string' || !row.name.trim() || typeof row.unit !== 'string' || !row.unit.trim() || typeof row.targetHoursPerUnit !== 'number' || !Number.isFinite(row.targetHoursPerUnit) || row.targetHoursPerUnit < 0 || row.targetHoursPerUnit > 1e12) source(input);
  for (const line of lines) if (line.catalogItemId && !values.some(row => row.id === line.catalogItemId)) input.fail(404, 'Catalog item not found.');
  return values;
}
function authorize(db, auth, op, h, input = defaults()) {
  authorizeActor(auth, op, input);
  if (auth.companyId != null && auth.companyId !== db.company.id || auth.user.companyId != null && auth.user.companyId !== db.company.id) input.fail(403, 'Current company permission required.');
  const project = scope(db, auth, projectId(op), h, input), items = rows(project.estimateItems, db, input);
  if (op.kind === 'estimateItemEdit' || op.kind === 'estimateItemRemove') {
    const item = items.find(row => row.id === Number(op.path.split('/')[5]));
    if (!item) input.fail(404, 'Estimate item not found.'); itemSource(item, input);
    if (op.kind === 'estimateItemRemove') {
      const projectIndex = db.projects.indexOf(project);
      for (const report of rows(db.reports, db, input)) {
        if (!Number.isSafeInteger(report.project) || !db.projects[report.project] || report.productionEntries !== undefined && !Array.isArray(report.productionEntries)) source(input);
        if (report.project === projectIndex && (report.productionEntries || []).some(entry => !entry || typeof entry !== 'object' || Object.hasOwn(entry, 'estimateItemId') && entry.estimateItemId != null && !input.id(entry.estimateItemId))) source(input);
        if (report.project === projectIndex && (report.productionEntries || []).some(entry => Number(entry.estimateItemId) === item.id)) input.fail(409, 'This estimate item is linked to daily reports. Edit it instead of deleting it so approved production stays intact.');
      }
    }
  }
  if (op.kind === 'estimateProposalCreate' || op.kind === 'estimateProposalApprove') {
    const proposals = rows(project.estimateProposals, db, input);
    if (op.kind === 'estimateProposalApprove') {
      const proposal = proposals.find(row => row.id === Number(op.path.split('/')[5]));
      if (!proposal) input.fail(404, 'Field estimate draft not found.'); itemSource(proposal, input);
    }
  }
  const hasPricing = pricing(db, auth.user, h, input);
  if (Object.hasOwn(op.details, 'cost') && op.details.cost > 0 && !hasPricing) input.fail(403, 'Existing pricing access required.');
  if (op.kind.startsWith('estimateImport')) {
    if (!hasPricing) input.fail(403, 'Existing pricing access required.');
    imports(db, op, auth, h, input); const values = catalog(db, op.details.lines, input);
    if (op.kind === 'estimateImportApprove') {
      if (typeof h.importBudgetHours !== 'function') input.fail(503, 'Existing estimate budget helper required.');
      if (!input.id(nextId(items) + op.details.lines.length - 1)) source(input);
      for (const line of op.details.lines) {
        const selected = line.catalogItemId ? values.find(row => row.id === line.catalogItemId) : values.find(row => row.name.toLowerCase() === line.description.toLowerCase() && row.unit === line.unit.toUpperCase());
        const budget = h.importBudgetHours(line, selected);
        if (budget !== null && (!Number.isFinite(budget) || budget < 0 || budget > 1e12)) input.fail(400, 'The resulting labor budget exceeds the supported range.');
      }
    }
  }
}
function itemDTO(row, hasPricing) { return { ...dto.pick(row, ['id', 'catalogItemId', 'name', 'plannedQuantity', 'unit', 'budgetHours', 'source', 'sourceImportId', 'sourceProposalId']), ...(hasPricing ? dto.pick(row, ['cost']) : {}) }; }
function proposalDTO(row) {
  const result = dto.pick(row, ['id', 'name', 'plannedQuantity', 'unit', 'createdBy', 'createdAt', 'status']);
  if (row.sourceFile !== undefined) result.sourceFile = row.sourceFile === null ? null : dto.pick(row.sourceFile, ['name', 'url']);
  return result;
}
function importDTO(row) {
  const result = dto.pick(row, ['id', 'projectId', 'filename', 'url', 'estimateNumber', 'status', 'createdAt', 'createdByUserId', 'reviewedAt', 'approvedAt', 'approvedLines', 'extractionMethod', 'documentTotal', 'lineTotal', 'reconciled', 'requiresOcr', 'requiresAiReview', 'duplicate', 'ocrWarning']);
  for (const key of ['lines', 'reviewedLines']) if (Object.hasOwn(row, key)) {
    if (!Array.isArray(row[key]) || row[key].length > 500) throw Object.assign(Error('Estimate lines need reconciliation.'), { statusCode: 409 });
    result[key] = row[key].map(line => ({ ...dto.pick(line, ['description', 'unit', 'quantity', 'amount', 'budgetHours', 'unitPrice', 'internalCost', 'catalogItemId', 'scopeStatus', 'budgetHoursUserEdited', 'confidence']), ...(Object.hasOwn(line, 'catalogSuggestions') ? { catalogSuggestions: dto.list(line.catalogSuggestions, suggestion => dto.pick(suggestion, ['id', 'name', 'unit', 'targetHoursPerUnit', 'score'])) } : {}) }));
  }
  if (Object.hasOwn(row, 'reviewWarnings')) { if (!Array.isArray(row.reviewWarnings) || row.reviewWarnings.some(value => typeof value !== 'string')) throw Object.assign(Error('Estimate warnings need reconciliation.'), { statusCode: 409 }); result.reviewWarnings = [...row.reviewWarnings]; }
  return result;
}
function readImports(db, user, projectId, h, input = defaults()) {
  if (!user || user.status !== 'Active' || !['owner', 'admin', 'project_manager'].includes(user.role)) input.fail(403, 'Existing pricing access required.');
  if (user.companyId != null && user.companyId !== db.company.id) input.fail(404, 'Project not found.');
  const current = rows(db.users, db, input).find(row => row.id === user.id);
  if (!current || current.status !== 'Active' || (current.role === 'office' ? 'admin' : current.role) !== user.role) input.fail(403, 'Current estimate account required.');
  const stored = { ...current, role: user.role };
  if (!pricing(db, user, h, input) || !pricing(db, stored, h, input)) input.fail(403, 'Existing pricing access required.');
  if (!input.id(projectId)) input.fail(400, 'Choose one current project.');
  scope(db, { user }, projectId, h, input); scope(db, { user: stored }, projectId, h, input);
  return rows(db.estimateImports, db, input).filter(row => row.status === 'Draft' && row.projectId === projectId).map(row => {
    if (!iso(row.createdAt) || !input.id(row.createdByUserId)) source(input);
    return importDTO(row);
  });
}
function validate(before, after, op, auth, h, input = defaults()) {
  authorize(before, auth, op, h, input);
  const old = before.projects.find(row => row.id === projectId(op)), project = after.projects?.find(row => row.id === old.id), d = op.details;
  if (!project || !equal(after.projects, before.projects.map(row => row.id === old.id ? project : row))) source(input);
  const oldItems = old.estimateItems || [], itemId = Number(op.path.split('/')[5]), hasPricing = pricing(after, auth.user, h, input);
  let expected = structuredClone(old), allowed = ['projects'], data, retained = { project: structuredClone(old) };
  if (op.kind === 'estimateItemCreate') {
    const item = { id: nextId(oldItems), name: d.name, plannedQuantity: d.plannedQuantity, unit: d.unit || 'EA', budgetHours: Object.hasOwn(d, 'budgetHours') ? d.budgetHours === null ? null : Math.round(d.budgetHours * 100) / 100 : 0, cost: d.cost || 0 };
    expected.estimateItems = [...oldItems, item]; data = itemDTO(item, hasPricing);
  } else if (op.kind === 'estimateItemEdit') {
    const item = oldItems.find(row => row.id === itemId), next = { ...item, ...d };
    for (const key of ['budgetHours', 'cost']) if (Object.hasOwn(d, key) && d[key] !== null) next[key] = Math.round(d[key] * 100) / 100;
    expected.estimateItems = oldItems.map(row => row.id === itemId ? next : row); data = itemDTO(next, hasPricing);
  } else if (op.kind === 'estimateItemRemove') {
    expected.estimateItems = oldItems.filter(row => row.id !== itemId); data = { ok: true, id: itemId };
  } else if (op.kind === 'estimateProposalCreate') {
    const proposals = old.estimateProposals || [], created = project.estimateProposals?.at(-1), at = created?.createdAt;
    if (!iso(at)) source(input);
    expected.estimateProposals = [...proposals, { id: nextId(proposals), ...d, sourceFile: null, createdBy: auth.user.name || 'Field team', createdAt: at, status: 'Needs office review' }];
    data = { created: 1, proposals: expected.estimateProposals.map(proposalDTO) };
  } else if (op.kind === 'estimateProposalApprove') {
    const proposals = old.estimateProposals || [], proposal = proposals.find(row => row.id === itemId);
    const item = { id: nextId(oldItems), name: proposal.name, plannedQuantity: proposal.plannedQuantity, unit: proposal.unit, budgetHours: null, cost: 0, source: 'field_proposal', sourceProposalId: proposal.id };
    expected.estimateItems = [...oldItems, item]; expected.estimateProposals = proposals.filter(row => row.id !== itemId);
    data = { item: itemDTO(item, hasPricing), proposals: expected.estimateProposals.map(proposalDTO) };
  } else {
    allowed.push('estimateImports'); const imported = imports(before, op, auth, h, input), next = after.estimateImports?.find(row => row.id === imported.id);
    if (!next || !equal(after.estimateImports, before.estimateImports.map(row => row.id === imported.id ? next : row))) source(input);
    retained.import = structuredClone(imported);
    if (op.kind === 'estimateImportDraft') {
      if (typeof h.enrichEstimateDraft !== 'function') input.fail(503, 'Existing estimate draft helper required.');
      if (!iso(next.reviewedAt)) source(input);
      const reviewed = d.lines.map(line => ({ description: line.description, unit: line.unit, confidence: 'medium', scopeStatus: line.scopeStatus === 'uncertain' ? 'uncertain' : 'included', catalogSuggestions: [], budgetHoursUserEdited: typeof line.budgetHoursUserEdited === 'boolean' ? line.budgetHoursUserEdited : line.budgetHours != null, ...Object.fromEntries(['quantity', 'amount', 'budgetHours', 'unitPrice', 'internalCost'].map(key => [key, line[key] ?? null])), catalogItemId: line.catalogItemId || null }));
      const values = before.catalog || [], reviewedLines = h.enrichEstimateDraft({ lines: reviewed }, values).lines.map(line => { const selected = values.find(item => item.id === line.catalogItemId); if (selected && !line.catalogSuggestions.some(item => item.id === selected.id)) line.catalogSuggestions.push({ ...selected, score: 0 }); return line; });
      if (!equal(next, { ...imported, reviewedLines, projectId: old.id, reviewedAt: next.reviewedAt })) source(input);
      if (!equal(project, old)) source(input); data = importDTO(next);
    } else if (op.kind === 'estimateImportApprove') {
      if (!iso(next.approvedAt)) source(input);
      const values = before.catalog || [], items = d.lines.map((line, index) => {
        const selected = line.catalogItemId ? values.find(item => item.id === line.catalogItemId) : values.find(item => item.name.toLowerCase() === line.description.toLowerCase() && item.unit === line.unit.toUpperCase());
        return { id: nextId(oldItems) + index, catalogItemId: selected?.id || null, name: line.description, plannedQuantity: line.quantity, unit: line.unit.toUpperCase(), budgetHours: h.importBudgetHours(line, selected), cost: line.amount == null ? null : line.amount, sourceImportId: imported.id };
      });
      expected.estimateItems = [...oldItems, ...items];
      if (!equal(next, { ...imported, status: 'Approved', projectId: old.id, approvedAt: next.approvedAt, approvedLines: items.length })) source(input);
      data = { import: importDTO(next), items: items.map(row => itemDTO(row, hasPricing)) };
    } else source(input);
  }
  if (!equal(project, expected) || !equal(omit(before, allowed), omit(after, allowed))) source(input);
  return { data, retained };
}
function currentResult(db, auth, receipt, first, h, input = defaults()) {
  const op = receipt.operation; authorizeActor(auth, op, input);
  if (auth.companyId != null && auth.companyId !== db.company.id || auth.user.companyId != null && auth.user.companyId !== db.company.id) input.fail(403, 'Current company permission required.');
  const technical = { id: op.kind.startsWith('estimateImport') ? Number(op.path.split('/')[3]) : receipt.result.id || receipt.result.item?.id || projectId(op), receiptId: receipt.id };
  // Numeric source IDs have no mandatory lifecycle key. A replay never looks
  // up those IDs, borrows a later incarnation or exposes retained old values.
  if (!first) return technical;
  let project;
  try { project = scope(db, auth, projectId(op), h, input); } catch (error) { if ([403, 404].includes(error.statusCode)) return technical; throw error; }
  const retained = receipt.retained?.project;
  if (!retained || !equal(omit(project, ['estimateItems', 'estimateProposals']), omit(retained, ['estimateItems', 'estimateProposals']))) return technical;
  const hasPricing = pricing(db, auth.user, h, input);
  if (op.kind === 'estimateItemRemove') return { ok: true, ...technical };
  if (op.kind.startsWith('estimateImport')) {
    if (!hasPricing) return technical;
    const imported = (db.estimateImports || []).find(row => row.id === technical.id), old = receipt.retained?.import;
    if (!imported || !old || !equal(omit(imported, ['reviewedLines', 'reviewedAt', 'projectId', 'approvedAt', 'approvedLines', 'status']), omit(old, ['reviewedLines', 'reviewedAt', 'projectId', 'approvedAt', 'approvedLines', 'status'])) || imported.projectId !== project.id) return technical;
    if (op.kind === 'estimateImportDraft') return importDTO(imported);
    const items = (project.estimateItems || []).filter(row => row.sourceImportId === imported.id && receipt.result.items.some(item => item.id === row.id));
    return items.length === receipt.result.items.length ? { import: importDTO(imported), items: items.map(row => itemDTO(row, true)) } : technical;
  }
  if (op.kind === 'estimateProposalCreate') return { created: 1, proposals: (project.estimateProposals || []).map(proposalDTO) };
  const item = (project.estimateItems || []).find(row => row.id === (receipt.result.item?.id || receipt.result.id));
  if (!item) return technical;
  return op.kind === 'estimateProposalApprove' ? { item: itemDTO(item, hasPricing), proposals: (project.estimateProposals || []).map(proposalDTO) } : itemDTO(item, hasPricing);
}
module.exports = { route, parse, authorizeActor, authorize, validate, currentResult, itemDTO, proposalDTO, importDTO, readImports };
