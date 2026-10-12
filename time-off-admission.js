'use strict';
const crypto = require('node:crypto');
const access = require('./time-off-access');
const availability = require('./schedule-availability');
const scheduling = require('./scheduling-access');
const { canonicalHash } = require('./database/transactional-repository');
const business = row => ({ memberId: row.memberId, startDate: row.startDate, endDate: row.endDate, allDay: row.allDay !== false, ...(row.allDay === false ? { startTime: row.startTime, endTime: row.endTime } : {}), type: row.type, note: row.note });
function parse(input) {
  const keys = ['startDate', 'endDate', 'allDay', 'startTime', 'endTime', 'type', 'note', 'requestId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)) return null;
  if (!availability.validDate(input.startDate) || !availability.validDate(input.endDate) || input.endDate < input.startDate || typeof input.allDay !== 'boolean' || !['vacation', 'sick', 'unpaid', 'other'].includes(input.type) || typeof input.note !== 'string' || input.note.length > 500) return null;
  if (!input.allDay && (input.startDate !== input.endDate || !availability.validTime(input.startTime) || !availability.validTime(input.endTime) || input.startTime >= input.endTime)) return null;
  if (input.allDay && ['startTime', 'endTime'].some(key => Object.hasOwn(input, key) && input[key] !== '')) return null;
  return { startDate: input.startDate, endDate: input.endDate, allDay: input.allDay, ...(!input.allDay ? { startTime: input.startTime, endTime: input.endTime } : {}), type: input.type, note: input.note.trim(), requestId: input.requestId };
}
function createHandler({ readDb, writeDb, body, json, now = () => new Date() }) {
  return async function handle(req, res, url) {
    if (!['/api/time-off-requests', '/api/schedule-availability'].includes(url.pathname)) return false;
    const db = readDb(), user = req.auth?.user;
    if (url.pathname === '/api/schedule-availability') {
      if (req.method !== 'GET' || !scheduling.access(db, user).view) { json(res, 403, { error: 'Scheduling view permission required' }); return true; }
      const ids = (db.team || []).map(member => member.id).filter(memberId => {
        if (['owner', 'admin'].includes(user.role)) return true;
        if (['field', 'foreman'].includes(user.role)) return memberId === user.memberId;
        const member = db.team.find(row => row.id === memberId);
        return (user.assignedCrews || []).some(name => String(name).trim().toLowerCase() === String(member.crew || '').trim().toLowerCase());
      });
      json(res, 200, availability.approved(db.timeOffRequests, ids)); return true;
    }
    if (req.method === 'GET') {
      if (!access.access(db, user).viewRequests) { json(res, 403, { error: 'Private time-off view permission required' }); return true; }
      json(res, 200, access.visible(db, user)); return true;
    }
    if (req.method !== 'POST' || !access.inScope(db, user, { memberId: user?.memberId }, 'createRequest')) { json(res, 403, { error: 'A permitted linked field account is required' }); return true; }
    const input = parse(await body(req));
    if (!input) { json(res, 400, { error: 'Enter valid typed time-off details and a save request ID' }); return true; }
    const details = business({ ...input, memberId: user.memberId }), inputHash = canonicalHash(details), prior = (db.timeOffActionReceipts || []).find(row => row.actorId === user.id && row.requestId === input.requestId);
    if (prior) {
      const row = (db.timeOffRequests || []).find(item => item.id === prior.recordId);
      if (prior.sessionHash !== req.auth.session.tokenHash || prior.inputHash !== inputHash || !access.inScope(db, user, row, 'createRequest') || canonicalHash(business(row)) !== inputHash) { json(res, 409, { error: 'This request ID was already used or its access/details changed' }); return true; }
      json(res, 200, access.present(row)); return true;
    }
    if ((db.timeOffRequests || []).some(row => row.memberId === user.memberId && row.requestId === input.requestId)) {
      json(res, 409, { error: 'This existing request needs review before a new save; its originating receipt is unavailable' }); return true;
    }
    const at = now().toISOString(), row = { id: crypto.randomUUID(), ...details, status: 'pending', requestedAt: at, history: [{ action: 'Requested', by: user.name, at }] };
    db.timeOffRequests ||= []; db.timeOffRequests.unshift(row);
    db.timeOffActionReceipts ||= []; db.timeOffActionReceipts.push({ id: crypto.randomUUID(), actorId: user.id, sessionHash: req.auth.session.tokenHash, requestId: input.requestId, inputHash, recordId: row.id });
    db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'time_off_requested', actorId: user.id, actor: user.name, recordId: row.id, memberId: row.memberId, at });
    writeDb(db); json(res, 201, access.present(row)); return true;
  };
}
module.exports = { parse, business, createHandler };
