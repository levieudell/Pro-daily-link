'use strict';
const crypto = require('node:crypto');
const access = require('./notes-access');
const { canonicalHash } = require('./database/transactional-repository');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row, keys) => Object.fromEntries(Object.entries(row || {}).filter(([key]) => !keys.includes(key)));
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
function validateDelta(before, after, user, method, projectId, itemId) {
  if (!equal(omit(before, ['projectNotesTodos']), omit(after, ['projectNotesTodos']))) fail(409, 'Notes cannot change unrelated company data');
  if (equal(before, after)) return null;
  const previous = before.projectNotesTodos || [], current = after.projectNotesTodos || [];
  if (method === 'POST') {
    if (current.length !== previous.length + 1 || !equal(current.slice(1), previous)) fail(409, 'Note creation changed unrelated records');
    const row = current[0]; access.unique(current, row.id, 'Created note');
    if (row.companyId !== before.company.id || Number(row.projectId) !== Number(projectId) || row.createdByUserId !== user.id || row.revision !== 1 || row.completed !== false || !['note', 'todo'].includes(row.kind) || row.history?.length !== 1) fail(409, 'New note bindings need reconciliation');
    return { action: 'create', row };
  }
  if (method !== 'PATCH' || current.length !== previous.length) fail(409, 'Notes view cannot change records');
  const old = access.unique(previous, itemId, 'Original note'), row = access.unique(current, itemId, 'Edited note');
  if (!equal(previous.filter(item => item !== old), current.filter(item => item !== row)) || !equal(omit(old, ['text', 'completed', 'dueDate', 'revision', 'updatedBy', 'updatedByUserId', 'updatedAt', 'history']), omit(row, ['text', 'completed', 'dueDate', 'revision', 'updatedBy', 'updatedByUserId', 'updatedAt', 'history'])) || row.revision !== old.revision + 1 || row.updatedByUserId !== user.id || row.history.length !== old.history.length + 1 || !equal(row.history.slice(0, -1), old.history)) fail(409, 'Note history or immutable bindings changed');
  return { action: old.completed !== row.completed ? old.text !== row.text || !equal(old.dueDate, row.dueDate) ? 'edit_and_complete' : 'complete' : 'edit', row };
}
function createHandler({ readDb, writeDb, body, json, run, response, assertCurrent, baselineProjectAllowed }) {
  return async function handle(req, res, url) {
    const route = url.pathname.match(/^\/api\/projects\/(\d+)\/notes-todos(?:\/([^/]+))?$/);
    if (!route) return false;
    try {
      const db = readDb(), user = req.auth.user, permissions = access.access(db, user), projectId = Number(route[1]), itemId = route[2];
      if (!permissions.view) fail(403, 'Notes viewing is disabled for your role');
      if (req.method === 'POST' && !permissions.create) fail(403, 'Creating notes is disabled for your role');
      if (!access.projectAllowed(db, user, projectId, baselineProjectAllowed)) fail(404, 'Project not found');
      access.validateRows(db, projectId);
      if (['POST', 'PATCH'].includes(req.method)) access.validateActor(user);
      if (req.method === 'PATCH') {
        const input = await body(req);
        if (input && typeof input === 'object' && ((Object.hasOwn(input, 'text') || Object.hasOwn(input, 'dueDate')) && !permissions.edit || Object.hasOwn(input, 'completed') && !permissions.complete)) fail(403, 'This note change is disabled for your role');
        const row = access.unique(db.projectNotesTodos, itemId, 'Note');
        if (row.companyId !== db.company.id || Number(row.projectId) !== projectId) fail(404, 'Note not found');
      }
      if (req.method === 'POST') {
        const input = await body(req), repeats = (db.projectNotesTodos || []).filter(row => row.companyId === db.company.id && Number(row.projectId) === projectId && row.createdByUserId === user.id && row.requestId === input?.requestId);
        if (repeats.length > 1) fail(409, 'Note save identity needs reconciliation');
      }
      const before = structuredClone(db); await run(req, res, url); const result = response();
      if (result?.status < 400 || result?.data?.item || result?.data?.items) await assertCurrent(req);
      if (result?.status < 400) {
        const after = readDb(); access.validateRows(after, projectId); const change = validateDelta(before, after, user, req.method, projectId, itemId);
        if (change) { after.auditLog ||= []; after.auditLog.push({ id: crypto.randomUUID(), type: 'project_note_changed', actorId: user.id, action: change.action, projectId, noteId: change.row.id, revision: change.row.revision, at: change.row.updatedAt }); writeDb(after); }
        if (req.method === 'GET') json(res, result.status, { ...result.data, permissions, notesPolicyRevision: user.notesPolicyRevision });
      }
      return true;
    } catch (error) { if (![400, 401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
module.exports = { validateDelta, createHandler };
