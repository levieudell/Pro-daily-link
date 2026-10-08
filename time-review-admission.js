'use strict';
const crypto = require('node:crypto');
const access = require('./time-review-access');
const profiles = require('./role-profiles');
const leaveAccess = require('./time-off-access');
const availability = require('./schedule-availability');
const { canonicalHash } = require('./database/transactional-repository');
const fail = (status, message) => { throw Object.assign(Error(message), { statusCode: status }); };
const object = (input, keys) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => keys.includes(key));
const key = value => String(value ?? '').trim();
function cardProjection(card) {
  const fields = ['id', 'projectId', 'memberId', 'date', 'inAt', 'outAt', 'hours', 'status', 'state', 'Status', 'approvalStatus', 'activityCodeId', 'activityName', 'workdayId', 'reportId', 'submittedAt', 'submittedBy', 'approvedAt', 'approvedBy', 'updatedAt'];
  const pick = (row, keys) => Object.fromEntries(keys.filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]]));
  const result = pick(card, fields);
  result.breaks = (Array.isArray(card.breaks) ? card.breaks : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => pick(row, ['type', 'startedAt', 'endedAt', 'missed', 'interrupted']));
  if (card.original && typeof card.original === 'object' && !Array.isArray(card.original)) result.original = pick(card.original, ['inAt', 'outAt', 'hours']);
  result.history = (Array.isArray(card.history) ? card.history : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => {
    const safe = pick(row, ['action', 'by', 'at', 'reason', 'previous']);
    for (const field of ['before', 'after']) if (row[field] && typeof row[field] === 'object' && !Array.isArray(row[field])) safe[field] = cardProjection({ ...row[field], history: [] });
    return safe;
  });
  return result;
}
function parsePreview(input, kind, id) {
  if (kind === 'leave') {
    if (!object(input, ['decision', 'note']) || !['approve', 'decline'].includes(input.decision) || Object.hasOwn(input, 'note') && (typeof input.note !== 'string' || input.note.length > 500)) fail(400, 'Review a supported leave decision and note');
    return { kind, decision: input.decision, ids: [id], note: (input.note || '').trim() };
  }
  if (!object(input, ['decision', 'ids']) || !['approve', 'unapprove'].includes(input.decision) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(value => !['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(key(value)) || !Number.isSafeInteger(Number(value)))) fail(400, 'Choose supported time cards and a review decision');
  const ids = [...new Set(input.ids.map(key))].sort((a, b) => Number(a) - Number(b));
  if (input.decision === 'unapprove' && ids.length !== 1) fail(400, 'Choose one approved time card to unapprove');
  return { kind, decision: input.decision, ids, note: '' };
}
function authority(db, req) {
  const user = req.auth.user;
  return canonicalHash({ companyId: db.company.id, actorId: user.id, role: user.role, name: user.name, permissions: user.permissions || {}, projectIds: user.projectIds || [], assignedCrews: user.assignedCrews || [], memberId: user.memberId || null, sessionHash: req.auth.session.tokenHash, access: access.access(db, user), leaveAccess: leaveAccess.access(db, user), timeReviewRolePolicy: db.company.timeReviewRolePolicy || null, timeReviewPolicyRequired: Boolean(db.company.timeReviewPolicyRequired), timeOffRolePolicy: db.company.timeOffRolePolicy || null, timeOffPolicyRequired: Boolean(db.company.timeOffPolicyRequired), ...(profiles.required(db) ? { roleProfiles: profiles.authority(db, user) } : {}) });
}
function createHandler({ readDb, writeDb, body, json, revision, isApproved, statusText, completeCard, overlap, upsert, presentCard, filterCards, mergeCopies, fieldAccess, now = () => new Date(), signingKey = crypto.randomBytes(32) }) {
  const sign = value => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return payload + '.' + crypto.createHmac('sha256', signingKey).update(payload).digest('base64url'); };
  const decode = token => {
    if (typeof token !== 'string' || token.length > 20000) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [payload, signature] = parts;
      if (!payload || !signature) return null;
      if (Buffer.from(payload, 'base64url').toString('base64url') !== payload) return null;
      const expected = crypto.createHmac('sha256', signingKey).update(payload).digest(), actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || actual.toString('base64url') !== signature || !crypto.timingSafeEqual(actual, expected)) return null;
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch { return null; }
  };
  function selected(db, user, operation, validate = true) {
    const action = operation.kind === 'leave' ? 'reviewLeave' : operation.decision === 'approve' ? 'approveCards' : 'unapproveCards';
    if (!access.access(db, user)[action]) fail(403, 'Time review permission required');
    const rows = operation.ids.map(id => {
      const candidates = (operation.kind === 'leave' ? db.timeOffRequests || [] : db.timeCards || []).filter(row => key(row.id) === id);
      const allowed = row => operation.kind === 'leave' ? access.leaveInScope(db, user, row) : access.cardInScope(db, user, row, action);
      if (!candidates.some(allowed)) fail(404, 'Review record not found');
      // upsert replaces every matching ID. Refuse ambiguity even if its other
      // copy is outside this actor's view, so no hidden record can be erased.
      if (candidates.length !== 1) fail(409, 'This record has duplicate identifiers and needs reconciliation');
      const row = candidates[0];
      if (!allowed(row)) fail(404, 'Review record not found');
      return row;
    });
    if (!validate) return rows;
    if (operation.kind === 'leave') {
      if (rows.some(row => !availability.approved([{ ...row, status: 'approved' }], [row.memberId]).length || !['pending', 'approved', 'declined'].includes(row.status))) fail(409, 'Refresh or correct the leave record before review');
    } else if (operation.decision === 'approve') {
      const pending = rows.filter(row => !isApproved(row));
      if (pending.some(row => statusText(row) !== 'submitted')) fail(409, 'Submit every selected time card before approval');
      if (pending.some(row => !completeCard(row))) fail(409, 'Complete and correct every selected time card before approval');
      if (pending.some(row => overlap(db, { memberId: row.memberId, inAt: row.inAt, outAt: row.outAt, id: row.id }))) fail(409, 'Cannot approve: a selected person has overlapping time');
    } else if (rows.some(row => !isApproved(row))) fail(409, 'Only an approved time card can be unapproved');
    return rows;
  }
  function result(db, req, operation, rows) {
    const cards = rows.map(row => presentCard(db.company, cardProjection(row)));
    return operation.kind === 'leave' ? leaveAccess.present(rows[0]) : operation.bulk ? { timeCards: cards } : cards[0];
  }
  function conflicts(db, operation, rows) {
    if (operation.kind !== 'leave' || operation.decision !== 'approve') return [];
    const leave = rows[0];
    // Leave is projectless. Disclosure is deliberately redacted even for an
    // office reviewer: no foreign project/customer/assignment identifiers.
    return (db.assignments || []).filter(row => (row.memberIds || []).map(Number).includes(Number(leave.memberId)) && row.date >= leave.startDate && row.date <= leave.endDate && (leave.allDay !== false || !availability.validTime(row.start) || !availability.validTime(row.end) || row.start < leave.endTime && row.end > leave.startTime)).map(row => ({ busy: true, date: row.date, ...(availability.validTime(row.start) && availability.validTime(row.end) ? { start: row.start, end: row.end } : {}) }));
  }
  return async function handle(req, res, url) {
    const leaveRoute = url.pathname.match(/^\/api\/time-off-requests\/([^/]+)\/(review-preview|approve|decline)$/);
    const cardRoute = url.pathname.match(/^\/api\/time-cards\/(\d+)\/(approve|unapprove)$/);
    const preview = leaveRoute?.[2] === 'review-preview' || url.pathname === '/api/time-cards/review-preview';
    const bulk = url.pathname === '/api/time-cards/approve';
    const read = url.pathname === '/api/time-cards' && req.method === 'GET';
    if (!leaveRoute && !cardRoute && !preview && !bulk && !read) return false;
    const db = readDb(), user = req.auth?.user;
    try {
      if (!leaveRoute && db.company?.features?.timeCards !== true) fail(404, 'Not found');
      if (read) {
        if (!access.access(db, user).viewCards) fail(403, 'Time view permission required');
        const requested = url.searchParams.get('memberId');
        if (['field', 'foreman'].includes(user.role) && requested && requested !== 'all' && Number(requested) !== Number(user.memberId)) fail(403, 'You can only open your own time cards');
        const groups = new Map();
        for (const row of db.timeCards || []) { const id = key(row.id); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
        const rows = [...groups.values()].filter(copies => copies.every(row => access.cardInScope(db, user, row))).map(copies => copies.length === 1 ? copies[0] : mergeCopies(copies));
        json(res, 200, filterCards(rows, url).map(row => ({ ...presentCard(db.company, cardProjection(row)), ...(['field', 'foreman'].includes(user.role) ? { fieldAccess: fieldAccess(db, user, row), projectName: (db.projects || []).find(project => Number(project.id) === Number(row.projectId))?.name || null, projectCode: (db.projects || []).find(project => Number(project.id) === Number(row.projectId))?.code || null } : {}) }))); return true;
      }
      if (req.method !== 'POST') fail(404, 'Not found');
      const input = await body(req);
      if (preview) {
        const operation = parsePreview(input, leaveRoute ? 'leave' : 'cards', leaveRoute?.[1]);
        const rows = selected(db, user, operation), currentRevision = revision(), actorHash = authority(db, req);
        const version = canonicalHash({ revision: currentRevision, actorHash, operation, rows });
        const token = sign({ ...operation, revision: currentRevision, actorHash, version, expiresAt: +now() + 10 * 60000 });
        json(res, 200, { token, version, revision: currentRevision, decision: operation.decision, note: operation.note, records: rows.map(row => operation.kind === 'leave' ? leaveAccess.present(row) : presentCard(db.company, cardProjection(row))), scheduledConflicts: conflicts(db, operation, rows), message: 'Review and explicitly confirm this decision. Existing schedules, hours, reports and payroll exports stay unchanged; no notification is created.' }); return true;
      }
      if (!object(input, ['token', 'version', 'confirmed', 'requestId']) || input.confirmed !== true || typeof input.token !== 'string' || input.token.length > 20000 || typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)) fail(400, 'Preview and explicitly confirm this decision with a request ID');
      const tokenHash = canonicalHash(input.token), inputHash = canonicalHash(input), prior = (db.timeReviewReceipts || []).find(row => row.tokenHash === tokenHash || row.actorId === user.id && row.requestId === input.requestId);
      let operation = prior?.operation || decode(input.token);
      if (!operation) fail(409, 'Preview is unavailable on this worker; preview again');
      const routeKind = leaveRoute ? 'leave' : 'cards', routeDecision = leaveRoute?.[2] || cardRoute?.[2] || 'approve';
      if (operation.kind !== routeKind || operation.decision !== routeDecision || !bulk && (operation.ids.length !== 1 || operation.ids[0] !== (leaveRoute?.[1] || cardRoute?.[1]))) fail(409, 'Preview does not match this decision route');
      operation = { kind: operation.kind, decision: operation.decision, ids: operation.ids, note: operation.note, bulk };
      const rows = selected(db, user, operation, !prior), actorHash = authority(db, req);
      if (prior) {
        if (prior.actorId !== user.id || prior.sessionHash !== req.auth.session.tokenHash || prior.inputHash !== inputHash || prior.actorHash !== actorHash || prior.rowsHash !== canonicalHash(rows) || prior.operation.bulk !== bulk) fail(409, 'This decision was already used or its authority or records changed');
        json(res, 200, result(db, req, operation, rows)); return true;
      }
      const signed = decode(input.token), plainOperation = { kind: operation.kind, decision: operation.decision, ids: operation.ids, note: operation.note };
      if (signed.expiresAt < +now() || signed.revision !== revision() || signed.actorHash !== actorHash || signed.version !== input.version || signed.version !== canonicalHash({ revision: revision(), actorHash, operation: plainOperation, rows })) fail(409, 'This company or review changed; preview again');
      const at = now().toISOString();
      if (operation.kind === 'leave') {
        const row = rows[0]; row.status = operation.decision === 'approve' ? 'approved' : 'declined'; row.reviewNote = operation.note; row.reviewedAt = at; row.reviewedBy = user.name;
        if (!Array.isArray(row.history)) row.history = [];
        row.history.push({ action: row.status === 'approved' ? 'Approved' : 'Declined', by: user.name, at, note: row.reviewNote });
      } else for (const row of rows) {
        if (operation.decision === 'approve' && isApproved(row)) continue;
        if (!Array.isArray(row.history)) row.history = [];
        if (operation.decision === 'approve') { row.status = 'approved'; row.approvedAt = at; row.approvedBy = user.name; row.history.push({ action: 'Approved', by: user.name, at }); }
        else { const previous = row.status ?? row.state ?? row.approvalStatus ?? 'approved'; Object.assign(row, { status: 'draft', submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null }); row.history.push({ action: 'Unapproved', by: user.name, at, previous }); }
        upsert(db, row);
      }
      db.timeReviewReceipts ||= []; db.timeReviewReceipts.push({ id: crypto.randomUUID(), actorId: user.id, sessionHash: req.auth.session.tokenHash, actorHash, requestId: input.requestId, tokenHash, inputHash, operation, rowsHash: canonicalHash(rows), at });
      db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: operation.kind === 'leave' ? 'time_off_reviewed' : 'time_cards_reviewed', actorId: user.id, actor: user.name, decision: operation.decision, recordIds: operation.ids, at });
      writeDb(db); json(res, 200, result(db, req, operation, rows)); return true;
    } catch (error) { if (![400, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
module.exports = { cardProjection, parsePreview, authority, createHandler };
