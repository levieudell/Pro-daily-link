'use strict';

const crypto = require('node:crypto');

const MAX_TEXT_LENGTH = 5000;
const ROLES = new Set(['owner', 'admin', 'project_manager', 'foreman', 'field']);

// This is a private tenant collection, deliberately kept out of /api/state.
// Responses are projected explicitly so unrelated snapshot fields never leak.
function contentSnapshot(row) {
  return { text: row.text, completed: row.completed === true, revision: row.revision };
}

function presentItem(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    ...contentSnapshot(row),
    createdBy: row.createdBy,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
    history: (row.history || []).map(entry => ({
      action: entry.action,
      by: entry.by,
      userId: entry.userId,
      at: entry.at,
      before: entry.before ? contentSnapshot(entry.before) : null,
      after: contentSnapshot(entry.after)
    }))
  };
}

function validateInput(input, allowedKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Enter a valid note or to-do';
  if (Object.keys(input).some(key => !allowedKeys.includes(key))) return 'Only note text and to-do status can be changed';
  return null;
}

function textValue(value) {
  if (typeof value !== 'string') return { error: 'Enter note or to-do text' };
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'Enter note or to-do text' };
  if (text.length > MAX_TEXT_LENGTH) return { error: `Use ${MAX_TEXT_LENGTH} characters or fewer` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { error: 'Remove unsupported control characters' };
  // Text is stored literally, never interpreted as HTML, Markdown, or an action.
  return { text };
}

function createProjectNotesHandler({ readDb, writeDb, body, json, authenticatedUser, canAccessProject }) {
  return async function handleProjectNotes(req, res, url) {
    const route = url.pathname.match(/^\/api\/projects\/(\d+)\/notes-todos(?:\/([^/]+))?$/);
    if (!route) return false;
    const reply = (status, data) => { json(res, status, data); return true; };
    const db = readDb(), user = authenticatedUser(req, db);
    // Always authenticate, including demo mode. Never trust a requested userId.
    if (!user) return reply(401, { error: 'Authentication required' });
    if (!ROLES.has(user.role)) return reply(403, { error: 'Project team permission required' });
    const projectId = Number(route[1]);
    const project = Number.isSafeInteger(projectId) && (db.projects || []).find(row => Number(row.id) === projectId);
    if (!project || !canAccessProject(db, user, projectId)) return reply(404, { error: 'Project not found' });
    const ownRows = (db.projectNotesTodos || []).filter(row => row.companyId === db.company.id && Number(row.projectId) === projectId);
    const itemId = route[2];

    if (req.method === 'GET' && !itemId) return reply(200, { projectId, items: ownRows.map(presentItem) });
    if (req.method === 'POST' && !itemId) {
      const input = await body(req);
      const invalid = validateInput(input, ['kind', 'text', 'requestId']);
      if (invalid) return reply(400, { error: invalid });
      if (!['note', 'todo'].includes(input.kind)) return reply(400, { error: 'Choose note or to-do' });
      const parsed = textValue(input.text);
      if (parsed.error) return reply(400, parsed);
      if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)) return reply(400, { error: 'A valid save request ID is required' });

      const previous = ownRows.find(row => row.createdByUserId === user.id && row.requestId === input.requestId);
      if (previous) {
        // Compare against original content, not the potentially edited current item.
        const original = previous.history?.[0]?.after;
        if (previous.kind !== input.kind || original?.text !== parsed.text) return reply(409, { error: 'This save request was already used for different content', code: 'PROJECT_NOTE_REQUEST_CONFLICT' });
        return reply(200, presentItem(previous));
      }

      const at = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(), companyId: db.company.id, projectId,
        requestId: input.requestId, kind: input.kind, text: parsed.text,
        completed: false, revision: 1,
        createdBy: user.name, createdByUserId: user.id, createdAt: at,
        updatedBy: user.name, updatedByUserId: user.id, updatedAt: at,
        history: []
      };
      row.history.push({ action: 'Created', by: user.name, userId: user.id, at, before: null, after: contentSnapshot(row) });
      db.projectNotesTodos ||= [];
      db.projectNotesTodos.unshift(row);
      writeDb(db);
      return reply(201, presentItem(row));
    }

    if (req.method === 'PATCH' && itemId) {
      const row = ownRows.find(item => item.id === itemId);
      if (!row) return reply(404, { error: 'Note or to-do not found' });
      const input = await body(req);
      const invalid = validateInput(input, ['revision', 'text', 'completed']);
      if (invalid) return reply(400, { error: invalid });
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) return reply(400, { error: 'The current revision is required' });
      if (!Object.hasOwn(input, 'text') && !Object.hasOwn(input, 'completed')) return reply(400, { error: 'Enter a change to save' });
      if (Object.hasOwn(input, 'completed') && (row.kind !== 'todo' || typeof input.completed !== 'boolean')) return reply(400, { error: 'Only to-dos can be marked complete or open' });
      const parsed = Object.hasOwn(input, 'text') ? textValue(input.text) : { text: row.text };
      if (parsed.error) return reply(400, parsed);
      if (row.revision !== input.revision) return reply(409, {
        error: 'Someone changed this item. Review the latest version before saving again.',
        code: 'PROJECT_NOTE_CONFLICT', item: presentItem(row)
      });
      const completed = Object.hasOwn(input, 'completed') ? input.completed : row.completed;
      if (parsed.text === row.text && completed === row.completed) return reply(200, presentItem(row));
      const before = contentSnapshot(row), at = new Date().toISOString();
      const textChanged = parsed.text !== row.text, statusChanged = completed !== row.completed;
      const action = statusChanged ? `${completed ? 'Completed' : 'Reopened'}${textChanged ? ' and edited' : ''}` : 'Edited';
      Object.assign(row, { text: parsed.text, completed, revision: row.revision + 1, updatedBy: user.name, updatedByUserId: user.id, updatedAt: at });
      row.history.push({ action, by: user.name, userId: user.id, at, before, after: contentSnapshot(row) });
      writeDb(db);
      return reply(200, presentItem(row));
    }

    return reply(405, { error: 'Method not allowed' });
  };
}

module.exports = { MAX_TEXT_LENGTH, contentSnapshot, presentItem, textValue, createProjectNotesHandler };
