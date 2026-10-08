'use strict';
const { permittedCompany } = require('./project-assistant-access');
const { allowed, minimalContext, activeProject, membersFor } = require('./project-assistant');
const { createIntentService, pricedModel } = require('./project-assistant-intent');
const { createBudget, createSharedStore, digest } = require('./project-assistant-budget');
const roles = new Set(['owner','admin','project_manager']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function createAIHandler({ readDb, readFreshDb = readDb, authenticatedUser, accountAccess, body, json, supabase, store, now = () => new Date(), adapter, enabled, signingKey }) {
  function authorize(req, db) {
    const user = authenticatedUser(req, db);
    if (!permittedCompany(db.company?.id)) throw Error('Assistant pilot access is unavailable.');
    if (!user || !roles.has(user.role) || user.companyId != null && user.companyId !== db.company.id || req.auth?.companyId != null && req.auth.companyId !== db.company.id || user.status !== 'Active') throw Error('Your assistant access changed. Sign in or use your permitted manual screens.');
    if (accountAccess(db.company).locked) throw Error('Company access is unavailable.');
    return { db, user, actor: { companyId: db.company.id, userId: user.id, role: user.role, permissions: user.permissions || {}, projectIds: user.projectIds || [], assignedCrews: user.assignedCrews || [], timezone: db.company.timezone || '', notesPermissions: user.notesPermissions, notesPolicyRevision: user.notesPolicyRevision, notesCustomRoleId: user.notesCustomRoleId } };
  }
  const budget = createBudget(store || createSharedStore(supabase), now);
  function context({ db, user }, projectId) {
    const projects = db.projects.filter(row => activeProject(db, Number(row.id)) && allowed(db, user, Number(row.id), null, 'project') && (allowed(db, user, Number(row.id)) || allowed(db, user, Number(row.id), null, 'note'))).map(row => ({ id: Number(row.id), name: String(row.name) }));
    if (projectId != null && !projects.some(row => row.id === projectId)) throw Error('That project is unavailable. Choose an authorized project.');
    const zone = db.company.timezone;let parts;
    try { if (!zone) throw Error('Missing timezone');parts=new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now()); }
    catch { throw Object.assign(Error('Ask the owner to confirm the company timezone in Company settings, then start a fresh request. Nothing has been saved.'),{code:'ASSISTANT_TIMEZONE_UNKNOWN'}); }
    const today = parts ? ['year','month','day'].map(key => parts.find(row => row.type === key).value).join('-') : '';
    if (!projectId) { if (projects.length > 20) throw Error('Select a project in Edit details to narrow the authorized context, then send your request.'); return { projects, timezone: zone || '', today }; }
    const selected = minimalContext(db, user, projectId, now());
    if (selected.members.length > 20 || projects.some(row => row.name.length > 160) || selected.members.some(row => row.name.length > 160)) throw Error('This project has too many display candidates. Use manual details to choose the person and preview.');
    return { ...selected, projects: projects.filter(row => row.id === projectId) };
  }
  return async function handleAI(req, res, url) {
    if (!['/api/assistant/context','/api/assistant/interpret'].includes(url.pathname)) return false;
    const reply = (status, value) => { json(res, status, value); return true; };
    try {
      const initial = authorize(req, readDb());
      const service = createIntentService({ budget, now, adapter, enabled, signingKey, active: () => !res.destroyed && !res.writableEnded,
        async contextFor(id, actor) { const current = authorize(req, await readFreshDb(req)); if (digest(current.actor) !== digest(actor)) throw Error('Your access changed. Start a new request.'); return context(current, id); },
        async refresh() { return authorize(req, await readFreshDb(req)).actor; } });
      if (url.pathname.endsWith('/context')) return req.method === 'GET' ? reply(200, { aiFirst: service.available(), disclosure: 'AI interpretation sends OpenAI your request, draft, company date/timezone and limited authorized project/team display names. Stored reports, files, billing and customer contacts are excluded.' }) : reply(405, { error: 'Method not allowed.' });
      if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
      const input = await body(req);
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !['text','state','sessionId','turnId','projectId','draft'].includes(key)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 6000 || !uuid(input.sessionId) || !uuid(input.turnId) || input.projectId != null && !Number.isSafeInteger(input.projectId) || input.state != null && (typeof input.state !== 'string' || input.state.length > 24000)) return reply(400, { error: 'Send one bounded message with its conversation and turn identifiers.' });
      return reply(200, await service.turn(input, initial.actor));
    } catch { return reply(403, { error: 'Assistant access or context is unavailable. Use your permitted manual screens.' }); }
  };
}
// Old clients cannot bypass accounting through the former optional extraction routes.
function legacyFallback() { return { source: 'form', draft: {}, message: 'Use normal Send for bounded AI interpretation, or complete manual details and preview. Nothing has been saved.' }; }
function normalAIAvailable() { try { pricedModel(new Date()); return process.env.PDL_ASSISTANT_AI_ENABLED === '1' && Boolean(process.env.OPENAI_API_KEY); } catch { return false; } }
module.exports = { createAIHandler, legacyFallback, normalAIAvailable };
