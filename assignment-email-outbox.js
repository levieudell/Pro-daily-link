'use strict';
const crypto = require('node:crypto');
const scheduling = require('./scheduling-access');
const { canonicalHash } = require('./database/transactional-repository');
const businessRecord = row => ({ id: row.id, projectId: row.projectId, memberIds: row.memberIds, date: row.date, start: row.start, end: row.end, activity: row.activity, instructions: row.instructions || null });
const credential = actor => ({ id: actor.id, role: actor.role, projectIds: actor.projectIds || [], assignedCrews: actor.assignedCrews || [], scheduleCrews: actor.permissions?.scheduleCrews === true });
function mark(db, job, status) {
  for (const assignment of db.assignments || []) {
    const original = Array.isArray(job.payload?.assignments) && job.payload.assignments.find(row => row?.id === assignment.id);
    if (original && canonicalHash(businessRecord(assignment)) === canonicalHash(original) && assignment.notifications?.[job.memberId]) assignment.notifications[job.memberId].emailStatus = status;
  }
}
function enqueue(db, auth, assignments, at = new Date().toISOString()) {
  if (!auth?.session?.tokenHash || !assignments.length || !assignments.every(row => scheduling.inScope(db, auth.user, row, 'create'))) throw Error('Authorized scheduling admission required');
  db.assignmentEmailOutbox ||= [];
  const members = new Set(assignments.flatMap(row => row.memberIds));
  for (const recipient of db.users || []) {
    if (recipient.status !== 'Active' || !['field', 'foreman'].includes(recipient.role) || recipient.companyId && recipient.companyId !== db.company.id || !members.has(recipient.memberId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email || '')) continue;
    const rows = assignments.filter(row => row.memberIds.includes(recipient.memberId));
    if (!rows.every(row => scheduling.inScope(db, recipient, row, 'view'))) continue;
    const project = (db.projects || []).find(row => row.id === rows[0].projectId);
    const id = crypto.randomUUID();
    db.assignmentEmailOutbox.push({ id, kind: 'assignment_email_v1', companyId: db.company.id, actorId: auth.user.id, sessionHash: auth.session.tokenHash, actorHash: canonicalHash(credential(auth.user)), policyRevision: db.company.schedulingRolePolicy?.revision || 0, recipientId: recipient.id, memberId: recipient.memberId, projectId: project.id, assignmentIds: rows.map(row => row.id), assignmentHash: canonicalHash(rows.map(businessRecord)), recipientHash: canonicalHash({ name: recipient.name, email: recipient.email, memberId: recipient.memberId }), payload: { to: recipient.email, name: recipient.name, companyName: db.company.name, projectName: project.name, assignments: rows.map(businessRecord) }, payloadHash: null, status: 'queued', createdAt: at });
    const job = db.assignmentEmailOutbox.at(-1); job.payloadHash = canonicalHash(job.payload);
    for (const row of rows) row.notifications[recipient.memberId].emailStatus = 'queued';
  }
}
function validEnvelope(job) {
  const keys = ['id', 'kind', 'companyId', 'actorId', 'sessionHash', 'actorHash', 'policyRevision', 'recipientId', 'memberId', 'projectId', 'assignmentIds', 'assignmentHash', 'recipientHash', 'payload', 'payloadHash', 'status', 'createdAt', 'lease', 'dispatchStartedAt', 'finishedAt', 'providerId'];
  const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  return job && typeof job === 'object' && !Array.isArray(job) && Object.keys(job).every(key => keys.includes(key)) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) && ['actorId', 'recipientId', 'memberId', 'projectId'].every(key => Number.isSafeInteger(job[key]) && job[key] > 0) && ['sessionHash', 'actorHash', 'assignmentHash', 'recipientHash', 'payloadHash'].every(key => digest(job[key])) && Number.isSafeInteger(job.policyRevision) && job.policyRevision >= 0 && Array.isArray(job.assignmentIds) && job.assignmentIds.length > 0 && job.assignmentIds.length <= 91 && job.assignmentIds.every(id => Number.isSafeInteger(id) && id > 0) && new Set(job.assignmentIds).size === job.assignmentIds.length && job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) && Array.isArray(job.payload.assignments);
}
function authorised(db, job, now) {
  try { return currentAuthority(db, job, now); } catch { return false; }
}
function currentAuthority(db, job, now) {
  if (!validEnvelope(job)) return false;
  if (!job || job.kind !== 'assignment_email_v1' || job.companyId !== db.company.id || canonicalHash(job.payload) !== job.payloadHash || !/^[0-9a-f-]{36}$/.test(job.id) || !Array.isArray(job.assignmentIds) || !job.assignmentIds.length) return false;
  const user = (db.users || []).find(row => row.id === job.actorId && row.status === 'Active' && (!row.companyId || row.companyId === db.company.id));
  const actor = user?.role === 'office' ? { ...user, role: 'admin' } : user;
  if (!actor || canonicalHash(credential(actor)) !== job.actorHash || (db.company.schedulingRolePolicy?.revision || 0) !== job.policyRevision || !(db.sessions || []).some(row => row.userId === actor.id && row.companyId === db.company.id && row.tokenHash === job.sessionHash && new Date(row.expiresAt).getTime() > now)) return false;
  const recipient = (db.users || []).find(row => row.id === job.recipientId && row.status === 'Active' && ['field', 'foreman'].includes(row.role) && (!row.companyId || row.companyId === db.company.id));
  const member = (db.team || []).find(row => row.id === job.memberId && !row.archivedAt && row.status !== 'Inactive');
  const project = (db.projects || []).find(row => row.id === job.projectId && !row.archived && row.status !== 'Inactive');
  if (!recipient || !member || !project || recipient.memberId !== job.memberId || canonicalHash({ name: recipient.name, email: recipient.email, memberId: recipient.memberId }) !== job.recipientHash || job.payload.to !== recipient.email || job.payload.name !== recipient.name || job.payload.companyName !== db.company.name || job.payload.projectName !== project.name || Object.keys(job.payload).some(key => !['to', 'name', 'companyName', 'projectName', 'assignments'].includes(key))) return false;
  const rows = job.assignmentIds.map(id => (db.assignments || []).find(row => row.id === id));
  return rows.every(row => row && row.projectId === job.projectId && row.memberIds.includes(job.memberId) && scheduling.inScope(db, actor, row, 'create') && scheduling.inScope(db, recipient, row, 'view')) && canonicalHash(rows.map(businessRecord)) === job.assignmentHash && canonicalHash(rows.map(businessRecord)) === canonicalHash(job.payload.assignments);
}
function createDispatcher({ load, commit, send, accountAllowed, now = () => Date.now() }) {
  if (typeof accountAllowed !== 'function') throw Error('Current account access check required');
  // There is no generic URL/effect dictionary and no bearer-link email support.
  async function record(companyId, id, lease, status, providerId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await load(companyId), job = current?.snapshot.assignmentEmailOutbox?.find(row => row.id === id);
      if (!job || job.status !== 'dispatching' || job.lease !== lease) return false;
      job.status = status; job.finishedAt = new Date(now()).toISOString(); if (providerId) job.providerId = providerId;
      mark(current.snapshot, job, status);
      try { await commit(current.snapshot, current.revision); return true; }
      catch (error) { if (error.code !== 'PDL_REVISION_CONFLICT') throw error; }
    }
    return false; // Never resend merely because receipt persistence conflicted.
  }
  async function dispatch(companyId, id) {
    const current = await load(companyId), job = current?.snapshot.assignmentEmailOutbox?.find(row => row.id === id);
    if (!job || job.status !== 'queued') return { dispatched: false };
    if (accountAllowed(current.snapshot) !== true || !authorised(current.snapshot, job, now()) || now() - Date.parse(job.createdAt) > 23 * 3600000 || Date.parse(job.createdAt) > now() + 10000 || !Number.isFinite(Date.parse(job.createdAt))) {
      job.status = 'cancelled'; job.finishedAt = new Date(now()).toISOString(); mark(current.snapshot, job, 'cancelled'); await commit(current.snapshot, current.revision); return { dispatched: false, cancelled: true };
    }
    job.status = 'dispatching'; job.lease = crypto.randomUUID(); job.dispatchStartedAt = new Date(now()).toISOString();
    // This CAS is the dispatch admission point. Later revocation cannot retract
    // a provider operation already admitted here. No provider call on a loser.
    await commit(current.snapshot, current.revision);
    const fresh = await load(companyId), reserved = fresh?.snapshot.assignmentEmailOutbox?.find(row => row.id === id);
    if (!reserved || reserved.status !== 'dispatching' || reserved.lease !== job.lease || accountAllowed(fresh.snapshot) !== true || !authorised(fresh.snapshot, reserved, now())) {
      await record(companyId, id, job.lease, 'cancelled'); return { dispatched: false, cancelled: true };
    }
    let result;
    try { result = await send(structuredClone(reserved.payload), 'pdl-assignment/' + reserved.id); }
    catch (error) { await record(companyId, id, job.lease, error.deliveryRejected ? 'failed' : 'uncertain'); return { dispatched: true, uncertain: !error.deliveryRejected }; }
    if (!result || typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) { await record(companyId, id, job.lease, 'uncertain'); return { dispatched: true, uncertain: true }; }
    const recorded = await record(companyId, id, job.lease, 'sent', result.id);
    return { dispatched: true, recorded };
  }
  return { dispatch };
}
module.exports = { businessRecord, enqueue, authorised, createDispatcher };
