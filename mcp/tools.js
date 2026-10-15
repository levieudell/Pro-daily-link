'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { estimateView } = require('./estimate');
const fieldWork = require('./field-work');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const keySchema = z.string().trim().min(8).max(200).describe('Unique key for this exact request. Reuse it if you retry.');
const quantitySchema = z.object({
  estimateItemId: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  laborHours: z.number().optional()
});
const hoursSchema = z.object({
  memberId: z.number().optional(),
  name: z.string().optional(),
  hours: z.number()
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((copy, key) => { copy[key] = stable(value[key]); return copy; }, {});
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function projectById(db, projectId) {
  return (db.projects || []).find(project => Number(project.id) === Number(projectId)) || null;
}

function projectIndex(db, projectId) {
  return (db.projects || []).findIndex(project => Number(project.id) === Number(projectId));
}

function publicProject(project) {
  return { id: project.id, name: project.name || '', customer: project.customer || '', status: project.status || '', site: project.site || '' };
}

function publicReport(db, report) {
  const project = db.projects?.[report.project];
  return {
    id: report.id,
    projectId: project?.id ?? null,
    projectName: project?.name || '',
    date: report.dateIso || report.date || '',
    status: report.status,
    foreman: report.foreman || '',
    crew: report.crew || '',
    notes: report.notes || '',
    weather: report.weather || '',
    delays: report.delays || '',
    quantities: (report.productionEntries || []).map(entry => ({
      estimateItemId: entry.estimateItemId ?? null,
      name: entry.description || '',
      quantity: Number(entry.quantity) || 0,
      unit: entry.unit || '',
      laborHours: Number(entry.laborHours) || 0
    })),
    crewHours: (report.laborEntries || []).map(entry => ({
      memberId: entry.memberId,
      name: (db.team || []).find(member => Number(member.id) === Number(entry.memberId))?.name || '',
      hours: Number(entry.hours) || 0,
      crew: entry.crew || ''
    }))
  };
}

function member(db, actor) {
  return (db.team || []).find(person => Number(person.id) === Number(actor.memberId)) || null;
}

function ownsReport(db, report, actor) {
  const person = member(db, actor);
  const memberId = Number(actor.memberId);
  if (person && report.foreman === person.name) return true;
  if (report.foreman === actor.name) return true;
  if ((report.laborEntries || []).some(entry => Number(entry.memberId) === memberId)) return true;
  return (db.workdays || []).some(workday => Number(workday.reportId) === Number(report.id) && (workday.memberIds || []).map(Number).includes(memberId));
}

function allowedProjectIds(db, actor) {
  if (actor.role !== 'field') return null;
  const person = member(db, actor);
  if (!person) return new Set();
  return actor.fieldProjectIds(db, person).allowedIds;
}

function todayAssignments(db, actor, date) {
  const memberId = Number(actor.memberId);
  return (db.assignments || []).filter(row => row.date === date && (row.memberIds || []).map(Number).includes(memberId));
}

function activeWorkday(db, actor) {
  const memberId = Number(actor.memberId);
  return (db.workdays || []).find(row => row.status === 'active' && (row.memberIds || []).map(Number).includes(memberId)) || null;
}

function resolveFieldProject(db, actor, projectId, { requireAssignment }) {
  const date = actor.companyDateIso(db.company);
  const assignments = todayAssignments(db, actor, date);
  const active = activeWorkday(db, actor);
  const assignedIds = [...new Set(assignments.map(row => Number(row.projectId)))];
  let chosen = projectId == null || projectId === '' ? null : Number(projectId);
  if (chosen == null) {
    if (!requireAssignment && active) chosen = Number(active.projectId);
    else if (assignedIds.length === 1) chosen = assignedIds[0];
    else if (!assignedIds.length) throw actor.fail('You have no assignment today.');
    else throw actor.fail('You have more than one job today. Pass projectId.');
  }
  const onAssignment = assignedIds.includes(Number(chosen));
  const onClock = !requireAssignment && active && Number(active.projectId) === Number(chosen);
  if (!onAssignment && !onClock) throw actor.fail('That job is not on your assignments today.');
  const project = projectById(db, chosen);
  if (!project) throw actor.fail('Project not found.');
  return { date, project, assignments, active };
}

function todaysOwnReports(db, actor, projectId, date) {
  const index = projectIndex(db, projectId);
  return (db.reports || []).filter(report => Number(report.project) === index && report.dateIso === date && ownsReport(db, report, actor));
}

function seenRequest(report, key) {
  const keys = report?.mcpRequestKeys || [];
  return keys.includes(key) || keys.includes(String(key).slice(0, 64));
}

function remember(deps, db, report, key, audit) {
  if (report) {
    report.mcpRequestKeys = [...new Set([...(report.mcpRequestKeys || []), key])];
    report.history ||= [];
    report.history.push({ action: 'Saved via AI connector', by: audit.actor, at: audit.at });
  }
  db.auditLog ||= [];
  db.auditLog.push({ id: crypto.randomUUID(), at: audit.at, actor: audit.actor, projectId: audit.projectId ?? null, type: audit.type, detail: audit.detail.endsWith('via AI connector') ? audit.detail : `${audit.detail} via AI connector` });
  deps.writeDb(db);
}

function noteFor(text, mapped) {
  const parts = [];
  const spoken = String(text || '').trim();
  if (spoken) parts.push(spoken);
  for (const row of mapped.unmatched || []) if (row && !parts.join('\n').includes(row)) parts.push(row);
  if (!parts.length && mapped.recorded.length) parts.push(mapped.recorded.map(row => `${row.quantity} ${row.item.unit || ''} ${row.item.name}`.replace(/\s+/g, ' ').trim()).join(', '));
  if (!parts.length && mapped.labor.length) parts.push(mapped.labor.map(row => `${row.member.name} ${row.hours} hours`).join(', '));
  return parts.join('\n\n').slice(0, 8000);
}

function workSummary(db, report, project, mapped, balanced) {
  return {
    reportId: report.id,
    status: report.status,
    date: report.dateIso || '',
    projectId: project.id,
    projectName: project.name || '',
    recorded: (mapped?.recorded || []).map(row => ({
      estimateItemId: row.item.id,
      name: row.item.name,
      unit: row.item.unit || '',
      quantityAdded: row.quantity,
      quantityTotal: Number((report.productionEntries || []).find(entry => String(entry.estimateItemId) === String(row.item.id))?.quantity) || 0
    })),
    labor: (mapped?.labor || []).map(row => ({
      memberId: row.member.id,
      name: row.member.name,
      hoursAdded: row.hours,
      hoursTotal: Number((report.laborEntries || []).find(entry => Number(entry.memberId) === Number(row.member.id))?.hours) || 0
    })),
    unmatched: mapped?.unmatched || [],
    notes: report.notes || '',
    needsHourSplit: balanced ? balanced.balanced === false : false,
    quantities: publicReport(db, report).quantities,
    crewHours: publicReport(db, report).crewHours
  };
}

function normalizeStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'draft') return 'Draft';
  if (text === 'needs review' || text === 'needs-review') return 'Needs review';
  if (text === 'approved') return 'Approved';
  if (text === 'missing data') return 'Missing data';
  return value || '';
}

function registerTools(server, ctx) {
  const { auth, host, oauth, deps } = ctx;
  const field = auth.role === 'field';
  const office = auth.role === 'owner' || auth.role === 'admin';
  const ToolError = host.ToolError;

  function fail(message, statusCode) {
    throw new ToolError(message, statusCode);
  }

  async function run(scope, fn) {
    if (!(auth.scopes || []).includes(scope)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `This connection does not include ${scope}.` }) }] };
    try {
      const data = await fn();
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      const message = error instanceof ToolError ? error.message : 'The connector could not finish that request.';
      if (!(error instanceof ToolError)) console.error('MCP tool failed', error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
    }
  }

  async function write(name, args, fn) {
    const key = String(args.idempotencyKey || '').trim();
    if (key.length < 8) fail('idempotencyKey is required.');
    try {
      return await oauth.idempotency(auth, name, key, hash(args), fn);
    } catch (error) {
      if (error.statusCode === 409) fail(error.message, 409);
      throw error;
    }
  }

  function open(fn) {
    return host.session(auth.companyId, auth, ({ db, actor, call }) => fn({
      db,
      actor: { ...actor, companyDateIso: deps.companyDateIso, fieldProjectIds: deps.fieldProjectIds, fail },
      call,
      fail
    }));
  }

  function scopeProjects(db, actor) {
    const allowed = allowedProjectIds(db, actor);
    return (db.projects || []).filter(project => !project.archived && (!allowed || allowed.has(project.id)));
  }

  if (office || field) {
    server.registerTool('list_projects', {
      title: 'List projects',
      description: 'List projects this connection may see. A field user only sees their own assignments.',
      inputSchema: {},
      annotations: READ
    }, async () => run('daily:read', () => open(({ db, actor }) => ({ projects: scopeProjects(db, actor).map(publicProject) }))));

    server.registerTool('get_estimate', {
      title: 'Get estimate',
      description: 'Estimate lines for one project: planned quantity, unit, approved done, remaining, budget hours, and used hours. Drafts do not change remaining.',
      inputSchema: { projectId: z.number().int().describe('Project id from list_projects.') },
      annotations: READ
    }, async args => run('daily:read', () => open(({ db, actor, fail: reject }) => {
      const allowed = allowedProjectIds(db, actor);
      if (allowed && !allowed.has(Number(args.projectId))) reject('Project not found.');
      const view = estimateView(db, args.projectId);
      if (!view || db.projects.find(project => Number(project.id) === Number(args.projectId))?.archived) reject('Project not found.');
      return view;
    })));

    server.registerTool('list_dailies', {
      title: 'List dailies',
      description: 'List daily reports. Optional projectId, from, to, and status. A field user only sees their own dailies.',
      inputSchema: {
        projectId: z.number().int().optional(),
        from: z.string().optional().describe('YYYY-MM-DD inclusive.'),
        to: z.string().optional().describe('YYYY-MM-DD inclusive.'),
        status: z.string().optional().describe('Draft, Needs review, or Approved.')
      },
      annotations: READ
    }, async args => run('daily:read', () => open(({ db, actor, fail: reject }) => {
      const allowed = allowedProjectIds(db, actor);
      if (args.projectId != null && allowed && !allowed.has(Number(args.projectId))) reject('Project not found.');
      const status = args.status ? normalizeStatus(args.status) : '';
      const rows = (db.reports || []).filter(report => {
        const project = db.projects?.[report.project];
        if (!project) return false;
        if (allowed && !ownsReport(db, report, actor)) return false;
        if (args.projectId != null && Number(project.id) !== Number(args.projectId)) return false;
        const date = report.dateIso || '';
        if (args.from && date && date < args.from) return false;
        if (args.to && date && date > args.to) return false;
        if (status && report.status !== status) return false;
        return true;
      }).map(report => {
        const view = publicReport(db, report);
        return { id: view.id, projectId: view.projectId, projectName: view.projectName, date: view.date, status: view.status, foreman: view.foreman };
      });
      return { dailies: rows };
    })));

    server.registerTool('get_daily', {
      title: 'Get daily',
      description: 'One daily report by id, without cost or rates. A field user can only open their own daily.',
      inputSchema: { id: z.number().int() },
      annotations: READ
    }, async args => run('daily:read', () => open(({ db, actor, fail: reject }) => {
      const report = (db.reports || []).find(row => Number(row.id) === Number(args.id));
      if (!report) reject('Daily not found.');
      if (actor.role === 'field' && !ownsReport(db, report, actor)) reject('Daily not found.');
      return publicReport(db, report);
    })));
  }

  if (office) {
    server.registerTool('create_daily', {
      title: 'Create daily',
      description: 'Save a new daily as Draft for office review later. This never approves. Unknown estimate lines are rejected.',
      inputSchema: {
        idempotencyKey: keySchema,
        projectId: z.number().int(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        notes: z.string().min(1).max(8000),
        quantities: z.array(quantitySchema).optional(),
        crewHours: z.array(hoursSchema).optional(),
        status: z.string().optional().describe('Ignored. The daily is always saved as Draft.')
      },
      annotations: WRITE
    }, async args => run('daily:write', () => write('create_daily', args, () => open(async ({ db, actor, call, fail: reject }) => {
      const project = projectById(db, args.projectId);
      if (!project || project.archived) reject('Project not found.');
      const mapped = fieldWork.mapFieldWork({ lines: args.quantities || [], crewHours: args.crewHours || [], estimateItems: project.estimateItems || [], team: db.team || [], anyCrew: true });
      if ((args.quantities || []).length && mapped.recorded.length !== args.quantities.length) reject('Every quantity must match one existing estimate line. Nothing was saved.');
      if ((args.crewHours || []).length && mapped.labor.length !== args.crewHours.length) reject('Every crew hour entry must match one person on this company. Nothing was saved.');
      const balanced = fieldWork.balanceHours(fieldWork.mergeProduction([], mapped.recorded), fieldWork.mergeLabor([], mapped.labor, db.team));
      const result = await call('POST', '/api/reports', {
        projectId: project.id,
        dateIso: args.date,
        status: 'Draft',
        notes: String(args.notes).trim(),
        clientTag: String(args.idempotencyKey).slice(0, 64),
        foreman: actor.name,
        productionEntries: balanced.entries.map(entry => ({ estimateItemId: entry.estimateItemId, description: entry.description, quantity: entry.quantity, unit: entry.unit || '', laborHours: entry.laborHours || 0 })),
        laborEntries: (balanced.entries && mapped.labor.length ? fieldWork.mergeLabor([], mapped.labor, db.team) : []).map(entry => ({ memberId: entry.memberId, hours: entry.hours, crew: entry.crew }))
      });
      if (result.status >= 400) reject(result.data?.error || 'The daily could not be saved.', result.status);
      const report = (db.reports || []).find(row => Number(row.id) === Number(result.data?.id));
      if (report && report.status !== 'Draft') report.status = 'Draft';
      remember(deps, db, report, args.idempotencyKey, { type: 'mcp_daily_created', actor: actor.name, projectId: project.id, at: new Date().toISOString(), detail: `Draft daily created for ${project.name} via AI connector` });
      const saved = (deps.readDb().reports || []).find(row => Number(row.id) === Number(result.data?.id)) || report;
      return { ...publicReport(db, saved), needsHourSplit: balanced.balanced === false };
    }))));

    server.registerTool('update_daily', {
      title: 'Update daily',
      description: 'Update a Draft or Needs review daily. Approved reports stay locked. This never approves.',
      inputSchema: {
        idempotencyKey: keySchema,
        id: z.number().int(),
        notes: z.string().max(8000).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        quantities: z.array(quantitySchema).optional(),
        crewHours: z.array(hoursSchema).optional(),
        status: z.string().optional()
      },
      annotations: WRITE
    }, async args => run('daily:write', () => write('update_daily', args, () => open(async ({ db, actor, call, fail: reject }) => {
      if (normalizeStatus(args.status) === 'Approved') reject('This connector never approves a daily.', 409);
      const report = (db.reports || []).find(row => Number(row.id) === Number(args.id));
      if (!report) reject('Daily not found.');
      if (!['Draft', 'Needs review'].includes(report.status)) reject('Approved reports are locked. This connector cannot change them.', 409);
      if (seenRequest(report, args.idempotencyKey)) return publicReport(db, report);
      const project = db.projects?.[report.project];
      if (!project) reject('Project not found.');
      let production = (report.productionEntries || []).map(entry => ({ ...entry }));
      let labor = (report.laborEntries || []).map(entry => ({ ...entry }));
      if (args.quantities) {
        const mapped = fieldWork.mapFieldWork({ lines: args.quantities, estimateItems: project.estimateItems || [], team: db.team || [], anyCrew: true });
        if (mapped.recorded.length !== args.quantities.length) reject('Every quantity must match one existing estimate line. Nothing was saved.');
        production = mapped.recorded.map(row => ({ estimateItemId: row.item.id, description: row.item.name, quantity: row.quantity, unit: row.item.unit || '', laborHours: row.laborHours || 0 }));
      }
      if (args.crewHours) {
        const mapped = fieldWork.mapFieldWork({ crewHours: args.crewHours, estimateItems: project.estimateItems || [], team: db.team || [], anyCrew: true });
        if (mapped.labor.length !== args.crewHours.length) reject('Every crew hour entry must match one person on this company. Nothing was saved.');
        labor = fieldWork.mergeLabor([], mapped.labor, db.team);
      }
      const balanced = fieldWork.balanceHours(production, labor);
      const result = await call('PATCH', `/api/reports/${report.id}`, {
        status: report.status,
        notes: args.notes != null ? String(args.notes) : report.notes,
        dateIso: args.date || report.dateIso,
        foreman: report.foreman,
        productionEntries: balanced.entries,
        laborEntries: labor
      });
      if (result.status >= 400) reject(result.data?.error || 'The daily could not be updated.', result.status);
      if (result.data?.status === 'Approved') reject('This connector never approves a daily.', 409);
      const saved = (db.reports || []).find(row => Number(row.id) === Number(report.id));
      remember(deps, db, saved, args.idempotencyKey, { type: 'mcp_daily_updated', actor: actor.name, projectId: project.id, at: new Date().toISOString(), detail: `Draft daily ${report.id} updated via AI connector` });
      return { ...publicReport(deps.readDb(), (deps.readDb().reports || []).find(row => Number(row.id) === Number(report.id)) || saved), needsHourSplit: balanced.balanced === false };
    }))));
  }

  if (field) {
    server.registerTool('get_my_day', {
      title: 'Get my day',
      description: 'Today’s assignment, job, crew, clock, and estimate lines with remaining quantities. Remaining counts approved work only.',
      inputSchema: {},
      annotations: READ
    }, async () => run('daily:read', () => open(({ db, actor }) => {
      const date = deps.companyDateIso(db.company);
      const person = member(db, actor);
      const assignments = todayAssignments(db, actor, date);
      const active = activeWorkday(db, actor);
      const projectIds = [...new Set(assignments.map(row => Number(row.projectId)))];
      const jobs = projectIds.map(projectId => {
        const project = projectById(db, projectId);
        const view = project ? estimateView(db, project.id) : null;
        const own = todaysOwnReports(db, actor, projectId, date);
        const draft = own.find(report => report.status === 'Draft') || null;
        const todayReports = own.filter(report => report.status === 'Draft' || report.status === 'Needs review');
        return {
          projectId,
          projectName: project?.name || '',
          lines: (view?.lines || []).map(line => ({
            ...line,
            todayQuantity: todayReports.flatMap(report => report.productionEntries || []).filter(entry => String(entry.estimateItemId) === String(line.estimateItemId)).reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0)
          })),
          draft: draft ? { id: draft.id, status: draft.status, notes: draft.notes || '', quantities: publicReport(db, draft).quantities, crewHours: publicReport(db, draft).crewHours } : null
        };
      });
      return {
        date,
        name: actor.name,
        crew: person?.crew || '',
        clock: active ? { clockedIn: true, workdayId: active.id, projectId: active.projectId, startedAt: active.startedAt } : { clockedIn: false },
        assignments: assignments.map(row => ({
          assignmentId: row.id,
          projectId: row.projectId,
          projectName: projectById(db, row.projectId)?.name || '',
          activity: row.activity || '',
          crew: person?.crew || '',
          people: (row.memberIds || []).map(id => (db.team || []).find(personRow => Number(personRow.id) === Number(id))?.name).filter(Boolean)
        })),
        jobs
      };
    })));

    server.registerTool('clock_in', {
      title: 'Clock in',
      description: 'Start today’s clock for the signed-in field user on their own assignment.',
      inputSchema: { idempotencyKey: keySchema, projectId: z.number().int().optional().describe('Required only when today has more than one assignment.') },
      annotations: WRITE
    }, async args => run('daily:write', () => write('clock_in', args, () => open(async ({ db, actor, call, fail: reject }) => {
      const { project } = resolveFieldProject(db, actor, args.projectId, { requireAssignment: true });
      const existing = activeWorkday(db, actor);
      if (existing) return { workdayId: existing.id, projectId: existing.projectId, projectName: projectById(db, existing.projectId)?.name || '', startedAt: existing.startedAt, status: existing.status, alreadyClockedIn: true };
      const result = await call('POST', '/api/workdays/start', { projectId: project.id, memberIds: [Number(actor.memberId)], clientTag: String(args.idempotencyKey).slice(0, 64), startNote: 'Clocked in via AI connector' });
      if (result.status === 409) {
        const openDay = activeWorkday(deps.readDb(), actor);
        if (openDay) return { workdayId: openDay.id, projectId: openDay.projectId, projectName: projectById(deps.readDb(), openDay.projectId)?.name || '', startedAt: openDay.startedAt, status: openDay.status, alreadyClockedIn: true };
        reject(result.data?.error || 'You are already clocked in.', 409);
      }
      if (result.status >= 400) reject(result.data?.error || 'The clock could not be started.', result.status);
      const workday = (db.workdays || []).find(row => Number(row.id) === Number(result.data?.id)) || result.data;
      remember(deps, db, null, args.idempotencyKey, { type: 'mcp_clock_in', actor: actor.name, projectId: project.id, at: new Date().toISOString(), detail: `Clocked in on ${project.name} via AI connector` });
      if (workday && db.workdays) {
        const stored = db.workdays.find(row => Number(row.id) === Number(workday.id));
        if (stored) stored.mcpRequestKeys = [...new Set([...(stored.mcpRequestKeys || []), args.idempotencyKey])];
        deps.writeDb(db);
      }
      return { workdayId: workday.id, projectId: project.id, projectName: project.name, startedAt: workday.startedAt, status: workday.status || 'active', alreadyClockedIn: false };
    }))));

    server.registerTool('clock_out', {
      title: 'Clock out',
      description: 'End the signed-in field user’s open clock and time card. Does not submit or approve the daily.',
      inputSchema: { idempotencyKey: keySchema },
      annotations: WRITE
    }, async args => run('daily:write', () => write('clock_out', args, () => open(async ({ db, actor, call, fail: reject }) => {
      const workday = activeWorkday(db, actor);
      const memberId = Number(actor.memberId);
      if (!workday) {
        const card = (db.timeCards || []).find(row => Number(row.memberId) === memberId && !row.outAt && !row.deletedAt);
        if (!card) reject('You are not clocked in.');
        const now = new Date().toISOString();
        card.outAt = now;
        card.hours = deps.quarterHours(card.inAt, now);
        card.history ||= [];
        card.history.push({ action: 'Closed', by: actor.name, at: now });
        remember(deps, db, null, args.idempotencyKey, { type: 'mcp_clock_out', actor: actor.name, projectId: card.projectId, at: now, detail: 'Clocked out via AI connector' });
        return { workdayId: card.workdayId || null, status: 'complete', endedAt: now, projectId: card.projectId, reportId: card.reportId || null, timeCard: { outAt: card.outAt, hours: card.hours } };
      }
      if (seenRequest(workday, args.idempotencyKey)) return { workdayId: workday.id, status: workday.status, endedAt: workday.endedAt || null, projectId: workday.projectId, reportId: workday.reportId || null, replayed: true };
      const date = deps.companyDateIso(db.company, new Date(workday.startedAt || Date.now()));
      const draft = todaysOwnReports(db, actor, workday.projectId, date).find(report => report.status === 'Draft') || null;
      const onlySelf = (workday.memberIds || []).map(Number).every(id => id === memberId);
      if (draft || !onlySelf) {
        const now = new Date().toISOString();
        if (onlySelf) {
          workday.endedAt = now;
          workday.status = 'complete';
          workday.endNotes = draft?.notes || 'Clocked out via AI connector';
          if (draft?.id) workday.reportId = draft.id;
          if (deps.timeCardsEnabled(db.company)) deps.closeTimeCards(db, workday, { id: draft?.id || null }, actor.name);
        } else {
          workday.memberIds = (workday.memberIds || []).filter(id => Number(id) !== memberId);
          for (const card of db.timeCards || []) {
            if (Number(card.workdayId) === Number(workday.id) && Number(card.memberId) === memberId && !card.outAt) {
              card.outAt = now;
              card.hours = deps.quarterHours(card.inAt, now);
              if (draft?.id) card.reportId = draft.id;
              card.history ||= [];
              card.history.push({ action: 'Closed', by: actor.name, at: now });
            }
          }
        }
        const card = (db.timeCards || []).find(row => Number(row.memberId) === memberId && Number(row.workdayId) === Number(workday.id));
        remember(deps, db, null, args.idempotencyKey, { type: 'mcp_clock_out', actor: actor.name, projectId: workday.projectId, at: now, detail: 'Clocked out via AI connector' });
        const stored = (deps.readDb().workdays || []).find(row => Number(row.id) === Number(workday.id));
        if (stored) {
          stored.mcpRequestKeys = [...new Set([...(stored.mcpRequestKeys || []), args.idempotencyKey])];
          deps.writeDb(deps.readDb());
        }
        return { workdayId: workday.id, status: onlySelf ? 'complete' : workday.status, endedAt: now, projectId: workday.projectId, reportId: draft?.id || workday.reportId || null, timeCard: card ? { outAt: card.outAt, hours: card.hours } : null };
      }
      const result = await call('POST', `/api/workdays/${workday.id}/end`, { notes: 'Clocked out via AI connector', foreman: actor.name });
      if (result.status >= 400) reject(result.data?.error || 'The clock could not be ended.', result.status);
      const ended = result.data?.workday || workday;
      const card = (deps.readDb().timeCards || []).find(row => Number(row.memberId) === memberId && Number(row.workdayId) === Number(workday.id));
      remember(deps, db, null, args.idempotencyKey, { type: 'mcp_clock_out', actor: actor.name, projectId: workday.projectId, at: new Date().toISOString(), detail: 'Clocked out via AI connector' });
      return { workdayId: ended.id, status: ended.status || 'complete', endedAt: ended.endedAt, projectId: ended.projectId, reportId: result.data?.report?.id || ended.reportId || null, timeCard: card ? { outAt: card.outAt, hours: card.hours } : null };
    }))));

    server.registerTool('log_work', {
      title: 'Log work',
      description: 'Add work to today’s draft daily. Pass quantities for a known estimate line when you can. Free text maps only onto an existing line; unmatched work is saved in notes and never becomes a new line.',
      inputSchema: {
        idempotencyKey: keySchema,
        text: z.string().max(8000).optional().describe('What the field user said, in their words.'),
        projectId: z.number().int().optional(),
        quantities: z.array(quantitySchema).optional().describe('Preferred. One entry per existing estimate line.'),
        crewHours: z.array(hoursSchema).optional().describe('Hours for the signed-in user or someone on their crew.')
      },
      annotations: WRITE
    }, async args => run('daily:write', () => write('log_work', args, () => open(async ({ db, actor, call, fail: reject }) => {
      const { date, project } = resolveFieldProject(db, actor, args.projectId, { requireAssignment: false });
      const own = todaysOwnReports(db, actor, project.id, date);
      if (own.some(report => report.status === 'Needs review' || report.status === 'Approved')) reject('Today’s daily was already sent to the office. Nothing was changed.');
      const draft = own.find(report => report.status === 'Draft') || null;
      if (draft && seenRequest(draft, args.idempotencyKey)) return { ...workSummary(db, draft, project, { recorded: [], labor: [], unmatched: [] }, { balanced: true }), replayed: true };
      const person = member(db, actor);
      if (!person) reject('Your field profile is not linked to a crew member.');
      const mapped = fieldWork.mapFieldWork({ text: args.text, lines: args.quantities, crewHours: args.crewHours, estimateItems: project.estimateItems || [], team: db.team || [], selfMemberId: person.id, selfCrew: person.crew });
      if (!mapped.recorded.length && !mapped.labor.length && !mapped.unmatched.length && !String(args.text || '').trim()) reject('Say what you did today.');
      const production = fieldWork.mergeProduction(draft?.productionEntries || [], mapped.recorded);
      const labor = mapped.labor.length ? fieldWork.mergeLabor(draft?.laborEntries || [], mapped.labor, db.team) : (draft?.laborEntries || []).map(entry => ({ ...entry }));
      const balanced = fieldWork.balanceHours(production, labor);
      const notes = fieldWork.appendNote(draft?.notes || '', noteFor(args.text, mapped));
      if (!notes.trim()) reject('A note is required before this work can be saved.');
      const payload = {
        status: 'Draft',
        notes,
        dateIso: date,
        foreman: actor.name,
        crew: person.crew || '',
        productionEntries: balanced.entries,
        laborEntries: labor,
        clientTag: String(args.idempotencyKey).slice(0, 64)
      };
      const result = draft
        ? await call('PATCH', `/api/reports/${draft.id}`, payload)
        : await call('POST', '/api/reports', { ...payload, projectId: project.id });
      if (!draft && result.status === 200 && String(result.data?.clientTag || '') === String(args.idempotencyKey).slice(0, 64)) {
        return { ...workSummary(db, result.data, project, mapped, balanced), replayed: true };
      }
      if (result.status >= 400) reject(result.data?.error || 'The work could not be saved.', result.status);
      const saved = (db.reports || []).find(row => Number(row.id) === Number(result.data?.id));
      if (!saved || saved.status !== 'Draft') reject('The work could not be saved on a draft daily.');
      remember(deps, db, saved, args.idempotencyKey, { type: 'mcp_log_work', actor: actor.name, projectId: project.id, at: new Date().toISOString(), detail: `Logged field work on ${project.name} via AI connector` });
      const fresh = (deps.readDb().reports || []).find(row => Number(row.id) === Number(saved.id));
      return workSummary(deps.readDb(), fresh, project, mapped, balanced);
    }))));

    server.registerTool('submit_daily', {
      title: 'Submit daily',
      description: 'After reading the summary back, send today’s draft to the office for review. confirm must be true. This never approves.',
      inputSchema: {
        idempotencyKey: keySchema,
        confirm: z.boolean().describe('True only after the field user confirms the summary.'),
        projectId: z.number().int().optional()
      },
      annotations: WRITE
    }, async args => run('daily:write', () => write('submit_daily', args, () => open(async ({ db, actor, call, fail: reject }) => {
      if (args.confirm !== true) reject('Read the summary back and pass confirm true before submitting.');
      const { date, project } = resolveFieldProject(db, actor, args.projectId, { requireAssignment: false });
      const own = todaysOwnReports(db, actor, project.id, date);
      const pending = own.find(report => report.status === 'Needs review');
      if (pending) return { ...publicReport(db, pending), submitted: true, alreadySubmitted: true };
      const draft = own.find(report => report.status === 'Draft');
      if (!draft) reject(own.some(report => report.status === 'Approved') ? 'Today’s daily is already approved and cannot be changed here.' : 'There is no draft daily to submit.');
      if (seenRequest(draft, args.idempotencyKey) && draft.status === 'Needs review') return { ...publicReport(db, draft), submitted: true };
      const crew = (draft.laborEntries || []).reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
      const allocated = (draft.productionEntries || []).reduce((sum, row) => sum + (Number(row.laborHours) || 0), 0);
      if (Math.abs(crew - allocated) >= 0.01) reject('Crew hours are not split across the lines yet. Say how the hours divide, then confirm again.');
      const result = await call('PATCH', `/api/reports/${draft.id}`, {
        status: 'Needs review',
        notes: draft.notes,
        dateIso: draft.dateIso,
        foreman: draft.foreman,
        productionEntries: draft.productionEntries || [],
        laborEntries: draft.laborEntries || []
      });
      if (result.status >= 400) reject(result.data?.error || 'The daily could not be sent for review.', result.status);
      const saved = (db.reports || []).find(row => Number(row.id) === Number(draft.id));
      if (!saved || saved.status !== 'Needs review') reject('The daily was not sent for review.');
      remember(deps, db, saved, args.idempotencyKey, { type: 'mcp_submit_daily', actor: actor.name, projectId: project.id, at: new Date().toISOString(), detail: `Daily ${saved.id} sent for office review via AI connector` });
      const fresh = (deps.readDb().reports || []).find(row => Number(row.id) === Number(saved.id));
      return { ...publicReport(deps.readDb(), fresh), submitted: true };
    }))));
  }
}

module.exports = { registerTools };
