'use strict';
// Validate the actual named handlers' complete business consequences.
const { canonicalHash } = require('./database/transactional-repository');
const dto = require('./compat-workspace-projections');
const input = require('./resource-inputs');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const fail = () => input.fail(409, 'Resource effects require reconciliation.');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const nextId = rows => Math.max(0, ...rows.map(row => Number(row.id) || 0)) + 1;
const settings = ['name', 'trade', 'email', 'phone', 'timezone', 'weekStart', 'overtimeRule', 'scheduleGraceMinutes', 'autoAdoptActualTimes', 'pricingAccess', 'contractValueTracking'];
function append(before, after, name) {
  const old = before[name] || [], rows = after[name];
  if (!Array.isArray(rows) || rows.length !== old.length + 1 || !equal(rows.slice(0, -1), old)) fail();
  return rows.at(-1);
}
function validateDirectory(db) {
  const rows = db.crews || [], ids = new Set(), names = new Set();
  if (!Array.isArray(rows) || rows.length > 10000) fail();
  for (const row of rows) {
    if (!row || !input.id(row.id) || ids.has(row.id) || row.companyId != null && row.companyId !== db.company.id || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || names.has(row.name.trim().toLowerCase())) fail();
    ids.add(row.id); names.add(row.name.trim().toLowerCase());
  }
  return rows;
}
function crew(row) { return dto.pick(row, ['id', 'name', 'createdAt', 'updatedAt', 'migratedFromTeam']); }
function memberResponse(db, actor) {
  return db.team.map(row => { const out = dto.team(row); if (!require('./capability-registry').effective(db, actor).timeReview.viewCards) delete out.hours; return out; });
}
function retained(before, after, op) {
  if (op.kind.startsWith('crew')) return { crews: structuredClone(before.crews || []), members: before.team.filter(row => !equal(row, after.team.find(value => value.id === row.id))).map(row => structuredClone(row)), accountCrews: before.users.filter(row => !equal(row.assignedCrews, after.users.find(value => value.id === row.id)?.assignedCrews)).map(row => ({ id: row.id, ...Object.hasOwn(row, 'assignedCrews') ? { assignedCrews: [...row.assignedCrews] } : {} })) };
  if (op.kind === 'companySettings' || op.kind === 'contractTracking') return { company: Object.fromEntries(settings.filter(name => Object.hasOwn(before.company, name)).map(name => [name, structuredClone(before.company[name])])) };
  if (op.kind === 'projectArchive') return { project: structuredClone(before.projects.find(row => row.id === Number(op.path.split('/')[3]))) };
  return {};
}
function validate(before, after, op, auth, helpers) {
  const d = op.details, actor = auth.user;
  let allowed, data;
  if (op.kind === 'customerCreate' || op.kind === 'teamCreate' || op.kind === 'projectCreate') {
    const name = { customerCreate: 'customers', teamCreate: 'team', projectCreate: 'projects' }[op.kind]; allowed = [name];
    const row = append(before, after, name), expected = { id: nextId(before[name] || []), ...d };
    if (op.kind === 'projectCreate') {
      if (before.company.features?.templates === true) {
        const templateId = d.templateId || before.company.defaultTemplateId || 'standard';
        const standard = { id: 'standard', versions: [{ version: 1 }] };
        const template = templateId === 'standard' ? standard : (before.dailyTemplates || []).find(row => String(row.id) === String(templateId)) || (!d.templateId ? standard : null);
        if (!template || !Number.isSafeInteger(template.versions?.at(-1)?.version)) fail();
        expected.templateId = template.id; expected.templateVersion = template.versions.at(-1).version;
      } else delete expected.templateId;
      if (!equal(row, expected)) fail();
      // An inherited broad creator receives only its submitted values and
      // server initialization. The receipt does not grant later project view.
      data = ['owner', 'admin'].includes(actor.role) ? dto.project(row, helpers.canViewPricing(after, actor)) : { id: row.id, ...d };
    } else { if (!equal(row, expected)) fail(); data = op.kind === 'customerCreate' ? dto.customer(row) : dto.team(row); }
  } else if (op.kind === 'projectArchive') {
    allowed = ['projects']; const target = Number(op.path.split('/')[3]), old = before.projects.find(row => row.id === target), row = after.projects.find(row => row.id === target);
    if (!row || row.archived !== d.archived || (d.archived ? !iso(row.archivedAt) : row.archivedAt !== null) || !equal(omit(row, ['archived', 'archivedAt']), omit(old, ['archived', 'archivedAt'])) || !equal(after.projects.filter(row => row.id !== target), before.projects.filter(row => row.id !== target))) fail();
    data = dto.project(row, helpers.canViewPricing(after, actor));
  } else if (op.kind === 'crewCreate' || op.kind === 'crewEdit' || op.kind === 'crewRemove') {
    validateDirectory(before); validateDirectory(after); allowed = ['crews', 'team', ...(op.kind === 'crewRemove' ? ['users', 'auditLog'] : [])];
    const target = Number(op.path.split('/')[3]), old = (before.crews || []).find(row => row.id === target), selected = new Set(d.memberIds || []);
    let row;
    if (op.kind === 'crewCreate') { row = append(before, after, 'crews'); if (!equal(omit(row, ['createdAt']), { id: nextId(before.crews || []), name: d.name }) || !iso(row.createdAt)) fail(); }
    else if (op.kind === 'crewEdit') {
      row = after.crews.find(row => row.id === target);
      if (!row || !old || row.name !== d.name || !iso(row.updatedAt) || !equal(omit(row, ['name', 'updatedAt']), omit(old, ['name', 'updatedAt'])) || !equal(after.crews.filter(row => row.id !== target), before.crews.filter(row => row.id !== target))) fail();
    } else { row = old; if (!old || !equal(after.crews, before.crews.filter(row => row.id !== target))) fail(); }
    const expectedTeam = before.team.map(member => {
      let name = member.crew;
      if (op.kind === 'crewRemove') { if (String(member.crew || '').toLowerCase() === old.name.toLowerCase()) name = 'Unassigned'; }
      else if (selected.has(Number(member.id))) name = d.name;
      else if (op.kind === 'crewEdit' && member.crew === old.name) name = 'Unassigned';
      return name === member.crew ? member : { ...member, crew: name };
    });
    if (!equal(after.team, expectedTeam)) fail();
    if (op.kind === 'crewRemove') {
      const expectedUsers = before.users.map(user => Array.isArray(user.assignedCrews) ? { ...user, assignedCrews: user.assignedCrews.filter(name => name.toLowerCase() !== old.name.toLowerCase()) } : user);
      if (!equal(after.users, expectedUsers)) fail();
      const audit = append(before, after, 'auditLog'), count = before.team.filter(row => String(row.crew || '').toLowerCase() === old.name.toLowerCase()).length;
      const expected = { type: 'crew_deleted', crewId: old.id, crewName: old.name, actor: actor.name, detail: `${old.name} deleted; ${count} team member${count === 1 ? '' : 's'} moved to Unassigned` };
      if (!uuid(audit.id) || !iso(audit.at) || !equal(omit(audit, ['id', 'at']), expected)) fail();
    }
    data = { ...(op.kind === 'crewRemove' ? { ok: true } : {}), crew: crew(row), crews: after.crews.map(crew), team: memberResponse(after, actor) };
  } else if (op.kind === 'companySettings' || op.kind === 'contractTracking') {
    allowed = ['company'];
    let expected;
    if (op.kind === 'contractTracking') expected = { ...before.company, contractValueTracking: d.enabled };
    else {
      const p = d.pricingAccess || before.company.pricingAccess || {}, eligible = new Set(before.users.filter(row => ['owner', 'admin', 'project_manager'].includes(row.role) && row.status === 'Active').map(row => row.id));
      expected = { ...before.company, name: d.name, trade: d.trade || '', email: d.email || '', phone: d.phone || '', ...require('./company-timezone').change(before.company, d).patch, weekStart: d.weekStart === 'sunday' ? 'sunday' : 'monday', overtimeRule: d.overtimeRule || before.company.overtimeRule || 'weekly40', scheduleGraceMinutes: d.scheduleGraceMinutes ?? before.company.scheduleGraceMinutes ?? 15, autoAdoptActualTimes: d.autoAdoptActualTimes ?? (before.company.autoAdoptActualTimes === true), pricingAccess: { enabled: p.enabled !== false, officeMode: p.officeMode === 'selected' ? 'selected' : 'all', userIds: [...new Set((p.userIds || []).map(Number))].filter(value => Number.isFinite(value) && eligible.has(value)) }, ...(Object.hasOwn(d, 'contractValueTracking') ? { contractValueTracking: d.contractValueTracking } : {}) };
    }
    if (!equal(after.company, expected)) fail(); data = dto.company(after.company, helpers.canViewPricing(after, actor));
  } else if (op.kind === 'activityCreate') {
    allowed = ['companyActivityCodes']; const old = before.companyActivityCodes || helpers.activities(structuredClone(before));
    const rows = after.companyActivityCodes, row = rows?.at(-1);
    if (!Array.isArray(rows) || rows.length !== old.length + 1 || !equal(rows.slice(0, -1), old) || !uuid(row.id) || !equal(omit(row, ['id']), { name: d.name, active: true })) fail(); data = dto.pick(row, ['id', 'name', 'active']);
  } else fail();
  if (!equal(omit(before, allowed), omit(after, allowed))) fail();
  return { data, retained: retained(before, after, op) };
}
function reconciliation(before, after) {
  validateDirectory(before); validateDirectory(after);
  const rows = structuredClone(before.crews || []);
  for (const name of [...new Set(before.team.map(row => String(row.crew || '').trim()).filter(name => name && !/^(office|unassigned)$/i.test(name)))]) if (!rows.some(row => row.name.toLowerCase() === name.toLowerCase())) {
    const actual = after.crews[rows.length]; if (!actual || actual.id !== nextId(rows) || actual.name !== name || actual.migratedFromTeam !== true || !iso(actual.createdAt) || Object.keys(actual).sort().join(',') !== 'createdAt,id,migratedFromTeam,name') fail(); rows.push(actual);
  }
  if (!equal(after.crews, rows) || !equal(omit(before, ['crews']), omit(after, ['crews']))) fail();
  return rows;
}
module.exports = { validate, reconciliation, validateDirectory, crew, memberResponse, settings, equal, omit, retained };
