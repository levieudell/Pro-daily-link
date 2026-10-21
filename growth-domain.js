'use strict';

// Pure growth-domain rules for the platform back office. This module performs
// no I/O and never invents missing commercial or attribution values. Callers
// are expected to persist the returned immutable records transactionally.
const crypto = require('node:crypto');

const STAGES = Object.freeze([
  'new',
  'contacted',
  'qualified',
  'demo_scheduled',
  'demo_held',
  'proposal',
  'won',
  'lost'
]);
const CLOSED_STAGES = Object.freeze(['won', 'lost']);
const TRANSITIONS = Object.freeze({
  new: Object.freeze(['contacted', 'qualified', 'demo_scheduled', 'lost']),
  contacted: Object.freeze(['qualified', 'demo_scheduled', 'lost']),
  qualified: Object.freeze(['demo_scheduled', 'demo_held', 'proposal', 'lost']),
  demo_scheduled: Object.freeze(['qualified', 'demo_held', 'lost']),
  demo_held: Object.freeze(['proposal', 'won', 'lost']),
  proposal: Object.freeze(['demo_held', 'won', 'lost']),
  won: Object.freeze([]),
  lost: Object.freeze([])
});
const UNKNOWN_BUCKET = 'unknown';
const UNASSIGNED_OWNER = 'unassigned';
const MAX_TEXT = Object.freeze({ short: 160, name: 200, note: 5000, reason: 1000, url: 2048 });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

class GrowthDomainError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'GrowthDomainError';
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, statusCode = 400, details) {
  throw new GrowthDomainError(code, message, statusCode, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label = 'input') {
  if (!isObject(value)) fail('invalid_input', `${label} must be an object`);
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) fail('unexpected_field', `${label} contains unsupported fields`, 400, { fields: unexpected.sort() });
}

function plainText(value, label, { max = MAX_TEXT.short, required = false, multiline = false } = {}) {
  if (value == null || value === '') {
    if (required) fail('required_field', `${label} is required`);
    return null;
  }
  if (typeof value !== 'string') fail('invalid_text', `${label} must be text`);
  const withoutControls = value.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');
  const normalized = multiline
    ? withoutControls.replace(/\r\n?/g, '\n').trim()
    : withoutControls.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    if (required) fail('required_field', `${label} is required`);
    return null;
  }
  if (normalized.length > max) fail('text_too_long', `${label} must be ${max} characters or fewer`);
  return normalized;
}

function identifier(value, label, { required = false } = {}) {
  const result = plainText(value, label, { max: 128, required });
  if (result != null && !SAFE_ID.test(result)) fail('invalid_identifier', `${label} is invalid`);
  return result;
}

function ownerIdentifier(value) {
  const result = identifier(value, 'Owner user ID');
  if (result === UNASSIGNED_OWNER) fail('reserved_owner_id', `Owner user ID ${UNASSIGNED_OWNER} is reserved for unassigned reporting`);
  return result;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('invalid_timestamp', `${label} must be an ISO timestamp with a timezone`);
  }
  return new Date(value).toISOString();
}

function contextTime(context = {}) {
  return timestamp(context.now || new Date().toISOString(), 'now');
}

function emailAddress(value) {
  const result = plainText(value, 'Email', { max: 254 });
  if (result != null && !EMAIL.test(result)) fail('invalid_email', 'Enter a valid email address');
  return result?.toLowerCase() || null;
}

function phoneNumber(value) {
  const result = plainText(value, 'Phone', { max: 40 });
  if (result == null) return null;
  const digits = result.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) fail('invalid_phone', 'Enter a valid phone number');
  return result;
}

function webUrl(value, label, { allowRelative = false } = {}) {
  const result = plainText(value, label, { max: MAX_TEXT.url });
  if (result == null) return null;
  if (allowRelative && /^\/(?!\/)/.test(result)) return result;
  let parsed;
  try { parsed = new URL(result); } catch { fail('invalid_url', `${label} must be a valid web address`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('invalid_url', `${label} must use a safe HTTP or HTTPS address`);
  return parsed.toString();
}

function money(input) {
  const amount = input.expectedMrrMinor;
  const currency = input.currency;
  if (amount == null && (currency == null || currency === '')) return { expectedMrrMinor: null, currency: null };
  if (!Number.isSafeInteger(amount) || amount < 0) fail('invalid_mrr', 'Expected MRR must be a non-negative integer in minor currency units');
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) fail('invalid_currency', 'Currency is required when expected MRR is known');
  return { expectedMrrMinor: amount, currency: currency.toLowerCase() };
}

function normalizeAttribution(input = {}) {
  const label = (value, name) => {
    const result = plainText(value, name, { max: MAX_TEXT.short });
    return normalizedWords(result) === UNKNOWN_BUCKET ? null : result;
  };
  return {
    source: label(input.source, 'Source'),
    medium: label(input.medium, 'Medium'),
    campaign: label(input.campaign, 'Campaign'),
    referrer: webUrl(input.referrer, 'Referrer'),
    landingPage: webUrl(input.landingPage, 'Landing page', { allowRelative: true })
  };
}

function normalizeCreate(input) {
  exactKeys(input, [
    'companyName', 'contactName', 'email', 'phone', 'ownerUserId', 'source', 'medium', 'campaign',
    'referrer', 'landingPage', 'plan', 'expectedMrrMinor', 'currency', 'nextAction', 'nextActionDueAt',
    'note', 'linkedCompanyId'
  ], 'Opportunity');
  const normalized = {
    companyName: plainText(input.companyName, 'Company name', { max: MAX_TEXT.name }),
    contactName: plainText(input.contactName, 'Contact name', { max: MAX_TEXT.name }),
    email: emailAddress(input.email),
    phone: phoneNumber(input.phone),
    ownerUserId: ownerIdentifier(input.ownerUserId),
    attribution: normalizeAttribution(input),
    plan: plainText(input.plan, 'Plan', { max: 80 }),
    ...money(input),
    linkedCompanyId: identifier(input.linkedCompanyId, 'Linked company ID'),
    note: plainText(input.note, 'Note', { max: MAX_TEXT.note, multiline: true }),
    nextAction: plainText(input.nextAction, 'Next action', { max: 500 }),
    nextActionDueAt: input.nextActionDueAt == null || input.nextActionDueAt === '' ? null : timestamp(input.nextActionDueAt, 'Next action due date')
  };
  if (![normalized.companyName, normalized.contactName, normalized.email, normalized.phone].some(Boolean)) {
    fail('missing_identity', 'Add a company, contact, email, or phone number');
  }
  if (Boolean(normalized.nextAction) !== Boolean(normalized.nextActionDueAt)) {
    fail('incomplete_next_action', 'A next action needs both a description and due date');
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function finalRecord(value) {
  return deepFreeze(clone(value));
}

function active(record) {
  return !CLOSED_STAGES.includes(record.stage);
}

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizedWords(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function duplicateMatches(records, candidate) {
  const email = candidate.email?.toLowerCase() || null;
  const phone = normalizedPhone(candidate.phone);
  const company = normalizedWords(candidate.companyName);
  const contact = normalizedWords(candidate.contactName);
  const matches = [];
  for (const record of records || []) {
    if (!record || !active(record)) continue;
    const reasons = [];
    if (email && record.email?.toLowerCase() === email) reasons.push('email');
    if (phone && normalizedPhone(record.phone) === phone) reasons.push('phone');
    if (company && contact && normalizedWords(record.companyName) === company && normalizedWords(record.contactName) === contact) reasons.push('company_and_contact');
    if (!reasons.length) continue;
    matches.push({ id: record.id, reasons, certainty: reasons.some(reason => reason === 'email' || reason === 'phone') ? 'exact' : 'probable' });
  }
  return matches.sort((a, b) => a.id.localeCompare(b.id));
}

function findDuplicates(records, input) {
  return duplicateMatches(records, normalizeCreate(input));
}

function eventId(recordId, kind, ordinal) {
  return `${recordId}:${kind}:${ordinal}`;
}

function createOpportunity(records, input, context = {}) {
  const normalized = normalizeCreate(input);
  const at = contextTime(context);
  const actorUserId = identifier(context.actorUserId, 'Actor user ID');
  const key = plainText(context.idempotencyKey, 'Idempotency key', { max: 200 });
  const keyHash = key ? hash(key) : null;
  const payloadHash = hash(normalized);
  if (keyHash) {
    const prior = (records || []).find(record => record?.idempotency?.keyHash === keyHash);
    if (prior) {
      if (prior.idempotency.payloadHash !== payloadHash) fail('idempotency_conflict', 'This idempotency key was already used for different data', 409);
      return deepFreeze({ status: 'idempotent', created: false, opportunity: finalRecord(prior), duplicates: [] });
    }
  }
  const duplicates = duplicateMatches(records, normalized);
  if (duplicates.some(item => item.certainty === 'exact') && context.allowExactDuplicate !== true) {
    return deepFreeze({ status: 'duplicate', created: false, opportunity: null, duplicates });
  }
  const idGenerator = context.idGenerator || crypto.randomUUID;
  const id = identifier(idGenerator(), 'Opportunity ID', { required: true });
  if ((records || []).some(record => record?.id === id)) fail('duplicate_id', 'Opportunity ID already exists', 409);
  const initialFollowUp = normalized.nextAction ? {
    id: eventId(id, 'followup', 1),
    description: normalized.nextAction,
    dueAt: normalized.nextActionDueAt,
    status: 'pending',
    createdAt: at,
    createdByUserId: actorUserId,
    ownerUserId: normalized.ownerUserId,
    completedAt: null,
    completedByUserId: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null
  } : null;
  const initialNote = normalized.note ? {
    id: eventId(id, 'note', 1), text: normalized.note, at, authorUserId: actorUserId
  } : null;
  const record = {
    id,
    version: 1,
    companyName: normalized.companyName,
    contactName: normalized.contactName,
    email: normalized.email,
    phone: normalized.phone,
    ownerUserId: normalized.ownerUserId,
    stage: 'new',
    attribution: normalized.attribution,
    plan: normalized.plan,
    expectedMrrMinor: normalized.expectedMrrMinor,
    currency: normalized.currency,
    nextAction: initialFollowUp?.description || null,
    nextActionDueAt: initialFollowUp?.dueAt || null,
    linkedCompanyId: normalized.linkedCompanyId,
    outcome: null,
    outcomeAt: null,
    lossReason: null,
    createdAt: at,
    updatedAt: at,
    createdByUserId: actorUserId,
    stageHistory: [{
      id: eventId(id, 'stage', 1), from: null, to: 'new', at, actorUserId,
      ownerUserId: normalized.ownerUserId, reason: 'Opportunity created', expectedMrrMinor: normalized.expectedMrrMinor,
      currency: normalized.currency
    }],
    notes: initialNote ? [initialNote] : [],
    followUps: initialFollowUp ? [initialFollowUp] : [],
    history: [{
      id: eventId(id, 'event', 1), type: 'created', at, actorUserId,
      details: { ownerUserId: normalized.ownerUserId, stage: 'new' }
    }],
    idempotency: keyHash ? { keyHash, payloadHash } : null
  };
  return deepFreeze({ status: 'created', created: true, opportunity: finalRecord(record), duplicates });
}

function checkRecord(record) {
  if (!isObject(record) || !identifier(record.id, 'Opportunity ID', { required: true }) || !STAGES.includes(record.stage) || !Number.isSafeInteger(record.version) || record.version < 1) {
    fail('invalid_record', 'Opportunity record is invalid');
  }
}

function mutationContext(record, context) {
  checkRecord(record);
  if (context.expectedVersion != null && context.expectedVersion !== record.version) fail('revision_conflict', 'Opportunity changed since it was opened', 409, { currentVersion: record.version });
  const at = contextTime(context);
  if (at < record.updatedAt) fail('invalid_chronology', 'Opportunity changes cannot be recorded before the previous change');
  return { at, actorUserId: identifier(context.actorUserId, 'Actor user ID') };
}

function appendHistory(draft, type, at, actorUserId, details) {
  draft.history.push({ id: eventId(draft.id, 'event', draft.history.length + 1), type, at, actorUserId, details });
}

function finishMutation(draft, at) {
  draft.version++;
  draft.updatedAt = at;
  return finalRecord(draft);
}

function updateOpportunity(record, patch, context = {}) {
  const allowed = [
    'companyName', 'contactName', 'email', 'phone', 'ownerUserId', 'source', 'medium', 'campaign',
    'referrer', 'landingPage', 'plan', 'expectedMrrMinor', 'currency', 'linkedCompanyId'
  ];
  exactKeys(patch, allowed, 'Opportunity update');
  if (!Object.keys(patch).length) fail('empty_update', 'Provide at least one field to update');
  const { at, actorUserId } = mutationContext(record, context);
  const draft = clone(record);
  const before = {};
  const after = {};
  const set = (key, value) => {
    if (Object.is(draft[key], value)) return;
    before[key] = draft[key];
    draft[key] = value;
    after[key] = value;
  };
  if (Object.hasOwn(patch, 'companyName')) set('companyName', plainText(patch.companyName, 'Company name', { max: MAX_TEXT.name }));
  if (Object.hasOwn(patch, 'contactName')) set('contactName', plainText(patch.contactName, 'Contact name', { max: MAX_TEXT.name }));
  if (Object.hasOwn(patch, 'email')) set('email', emailAddress(patch.email));
  if (Object.hasOwn(patch, 'phone')) set('phone', phoneNumber(patch.phone));
  if (Object.hasOwn(patch, 'ownerUserId')) set('ownerUserId', ownerIdentifier(patch.ownerUserId));
  if (Object.hasOwn(patch, 'plan')) set('plan', plainText(patch.plan, 'Plan', { max: 80 }));
  if (Object.hasOwn(patch, 'linkedCompanyId')) set('linkedCompanyId', identifier(patch.linkedCompanyId, 'Linked company ID'));
  if (Object.hasOwn(patch, 'expectedMrrMinor') || Object.hasOwn(patch, 'currency')) {
    const next = money({
      expectedMrrMinor: Object.hasOwn(patch, 'expectedMrrMinor') ? patch.expectedMrrMinor : draft.expectedMrrMinor,
      currency: Object.hasOwn(patch, 'currency') ? patch.currency : draft.currency
    });
    set('expectedMrrMinor', next.expectedMrrMinor);
    set('currency', next.currency);
  }
  const attributionFields = ['source', 'medium', 'campaign', 'referrer', 'landingPage'];
  if (attributionFields.some(key => Object.hasOwn(patch, key))) {
    const next = normalizeAttribution({ ...draft.attribution, ...Object.fromEntries(attributionFields.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]])) });
    if (JSON.stringify(next) !== JSON.stringify(draft.attribution)) {
      before.attribution = draft.attribution;
      draft.attribution = next;
      after.attribution = next;
    }
  }
  if (![draft.companyName, draft.contactName, draft.email, draft.phone].some(Boolean)) fail('missing_identity', 'Keep a company, contact, email, or phone number');
  if (!Object.keys(after).length) fail('no_change', 'The update does not change this opportunity');
  appendHistory(draft, 'updated', at, actorUserId, { before, after });
  return finishMutation(draft, at);
}

function transitionOpportunity(record, toStage, context = {}) {
  if (!STAGES.includes(toStage)) fail('invalid_stage', 'Choose a valid opportunity stage');
  const { at, actorUserId } = mutationContext(record, context);
  if (!TRANSITIONS[record.stage].includes(toStage)) fail('invalid_transition', `Cannot move an opportunity from ${record.stage} to ${toStage}`, 409);
  const reason = plainText(context.reason, 'Stage reason', { max: MAX_TEXT.reason });
  const lossReason = plainText(context.lossReason, 'Loss reason', { max: MAX_TEXT.reason });
  if (toStage === 'lost' && !lossReason) fail('loss_reason_required', 'A lost opportunity needs a loss reason');
  if (toStage !== 'lost' && lossReason) fail('unexpected_loss_reason', 'Loss reason is only valid when an opportunity is lost');
  const draft = clone(record);
  const from = draft.stage;
  draft.stage = toStage;
  draft.stageHistory.push({
    id: eventId(draft.id, 'stage', draft.stageHistory.length + 1), from, to: toStage, at, actorUserId,
    ownerUserId: draft.ownerUserId, reason, expectedMrrMinor: draft.expectedMrrMinor, currency: draft.currency
  });
  if (CLOSED_STAGES.includes(toStage)) {
    draft.outcome = toStage;
    draft.outcomeAt = at;
    draft.lossReason = toStage === 'lost' ? lossReason : null;
  }
  appendHistory(draft, 'stage_changed', at, actorUserId, { from, to: toStage, reason, lossReason: toStage === 'lost' ? lossReason : null });
  return finishMutation(draft, at);
}

function addNote(record, text, context = {}) {
  const { at, actorUserId } = mutationContext(record, context);
  const note = plainText(text, 'Note', { max: MAX_TEXT.note, required: true, multiline: true });
  const draft = clone(record);
  const row = { id: eventId(draft.id, 'note', draft.notes.length + 1), text: note, at, authorUserId: actorUserId };
  draft.notes.push(row);
  appendHistory(draft, 'note_added', at, actorUserId, { noteId: row.id });
  return finishMutation(draft, at);
}

function setNextAction(record, input, context = {}) {
  exactKeys(input, ['description', 'dueAt', 'replaceReason'], 'Next action');
  const { at, actorUserId } = mutationContext(record, context);
  const description = plainText(input.description, 'Next action', { max: 500, required: true });
  const dueAt = timestamp(input.dueAt, 'Next action due date');
  const replaceReason = plainText(input.replaceReason, 'Replacement reason', { max: MAX_TEXT.reason });
  const draft = clone(record);
  const pending = draft.followUps.find(item => item.status === 'pending');
  if (pending && !replaceReason) fail('pending_action_exists', 'Complete or cancel the current next action before replacing it', 409);
  if (pending) {
    pending.status = 'cancelled';
    pending.cancelledAt = at;
    pending.cancelledByUserId = actorUserId;
    pending.cancellationReason = replaceReason;
  }
  const followUp = {
    id: eventId(draft.id, 'followup', draft.followUps.length + 1), description, dueAt, status: 'pending',
    createdAt: at, createdByUserId: actorUserId, ownerUserId: draft.ownerUserId,
    completedAt: null, completedByUserId: null, cancelledAt: null, cancelledByUserId: null, cancellationReason: null
  };
  draft.followUps.push(followUp);
  draft.nextAction = description;
  draft.nextActionDueAt = dueAt;
  appendHistory(draft, pending ? 'next_action_replaced' : 'next_action_set', at, actorUserId, { followUpId: followUp.id, replacedFollowUpId: pending?.id || null });
  return finishMutation(draft, at);
}

function closeNextAction(record, context = {}, status) {
  const { at, actorUserId } = mutationContext(record, context);
  const draft = clone(record);
  const pending = draft.followUps.find(item => item.status === 'pending');
  if (!pending) fail('no_pending_action', 'This opportunity has no pending next action', 409);
  if (status === 'cancelled') {
    const reason = plainText(context.reason, 'Cancellation reason', { max: MAX_TEXT.reason, required: true });
    pending.status = 'cancelled'; pending.cancelledAt = at; pending.cancelledByUserId = actorUserId; pending.cancellationReason = reason;
  } else {
    pending.status = 'completed'; pending.completedAt = at; pending.completedByUserId = actorUserId;
  }
  draft.nextAction = null;
  draft.nextActionDueAt = null;
  appendHistory(draft, status === 'cancelled' ? 'next_action_cancelled' : 'next_action_completed', at, actorUserId, { followUpId: pending.id });
  return finishMutation(draft, at);
}

function completeNextAction(record, context = {}) {
  return closeNextAction(record, context, 'completed');
}

function cancelNextAction(record, context = {}) {
  return closeNextAction(record, context, 'cancelled');
}

function listOpportunities(records, query = {}) {
  exactKeys(query, ['ownerUserId', 'stages', 'source', 'search', 'due', 'asOf', 'linkedCompanyId', 'sort', 'limit', 'offset'], 'Opportunity query');
  const owner = query.ownerUserId == null ? null : (query.ownerUserId === UNASSIGNED_OWNER ? null : identifier(query.ownerUserId, 'Owner user ID'));
  const stages = query.stages == null ? null : Array.isArray(query.stages) && query.stages.length && query.stages.every(stage => STAGES.includes(stage)) ? new Set(query.stages) : fail('invalid_stage_filter', 'Choose valid stages');
  const source = query.source == null ? null : plainText(query.source, 'Source', { max: MAX_TEXT.short, required: true });
  const search = normalizedWords(query.search);
  const due = query.due || 'all';
  if (!['all', 'overdue', 'upcoming', 'none'].includes(due)) fail('invalid_due_filter', 'Choose a valid due filter');
  const asOf = query.asOf ? timestamp(query.asOf, 'As-of date') : new Date().toISOString();
  const linkedCompanyId = query.linkedCompanyId == null ? null : identifier(query.linkedCompanyId, 'Linked company ID');
  const sort = query.sort || 'updated_desc';
  if (!['updated_desc', 'created_desc', 'next_action_asc', 'company_asc'].includes(sort)) fail('invalid_sort', 'Choose a valid opportunity sort');
  const limit = query.limit == null ? 100 : query.limit;
  const offset = query.offset == null ? 0 : query.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) fail('invalid_pagination', 'Use a limit of 1-200 and a non-negative offset');
  let items = (records || []).filter(record => {
    if (!record) return false;
    if (query.ownerUserId != null && record.ownerUserId !== owner) return false;
    if (stages && !stages.has(record.stage)) return false;
    if (source != null && (source === UNKNOWN_BUCKET ? record.attribution?.source != null : normalizedWords(record.attribution?.source) !== normalizedWords(source))) return false;
    if (linkedCompanyId != null && record.linkedCompanyId !== linkedCompanyId) return false;
    const isOverdue = record.nextActionDueAt != null && record.nextActionDueAt <= asOf;
    if (due === 'overdue' && !isOverdue) return false;
    if (due === 'upcoming' && (record.nextActionDueAt == null || isOverdue)) return false;
    if (due === 'none' && record.nextActionDueAt != null) return false;
    if (search) {
      const haystack = [record.companyName, record.contactName, record.email, record.phone, record.plan, ...record.notes.map(note => note.text)].map(normalizedWords).join(' ');
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const compare = {
    updated_desc: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    created_desc: (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    next_action_asc: (a, b) => (a.nextActionDueAt || '9999').localeCompare(b.nextActionDueAt || '9999') || a.id.localeCompare(b.id),
    company_asc: (a, b) => (a.companyName || '').localeCompare(b.companyName || '') || a.id.localeCompare(b.id)
  }[sort];
  items = items.sort(compare);
  return deepFreeze({ total: items.length, offset, limit, items: items.slice(offset, offset + limit).map(finalRecord) });
}

function inRange(value, from, to) {
  return value >= from && value < to;
}

function breakdown(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = normalizedWords(key(row)) || UNKNOWN_BUCKET;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts].map(([bucket, count]) => ({ bucket, count })).sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
}

function currencyTotals() {
  const map = new Map();
  return {
    add(currency, value) { map.set(currency, (map.get(currency) || 0) + value); },
    rows() { return [...map].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((a, b) => a.currency.localeCompare(b.currency)); }
  };
}

function growthMetrics(records, options = {}) {
  exactKeys(options, ['from', 'to', 'asOf'], 'Growth metrics options');
  const asOf = options.asOf ? timestamp(options.asOf, 'As-of date') : new Date().toISOString();
  const from = options.from ? timestamp(options.from, 'Period start') : '1970-01-01T00:00:00.000Z';
  const to = options.to ? timestamp(options.to, 'Period end') : asOf;
  if (from >= to || to > asOf) fail('invalid_period', 'Choose a period ending no later than the as-of date');
  const safeRecords = (records || []).filter(record => record?.createdAt <= asOf);
  const cohort = safeRecords.filter(record => inRange(record.createdAt, from, to));
  const funnel = Object.fromEntries(STAGES.map(stage => [stage, cohort.filter(record => record.stageHistory.some(event => event.to === stage && event.at <= asOf)).length]));
  const pipelineMrr = currencyTotals();
  let pipelineMrrUnknownCount = 0;
  const pipeline = safeRecords.filter(active);
  for (const record of pipeline) {
    if (record.expectedMrrMinor == null || !record.currency) pipelineMrrUnknownCount++;
    else pipelineMrr.add(record.currency, record.expectedMrrMinor);
  }
  const overdueItems = pipeline.filter(record => record.nextActionDueAt != null && record.nextActionDueAt <= asOf).map(record => ({ id: record.id, ownerUserId: record.ownerUserId || UNASSIGNED_OWNER, dueAt: record.nextActionDueAt })).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  const ownerRows = new Map();
  function ownerRow(ownerUserId) {
    const key = ownerUserId || UNASSIGNED_OWNER;
    if (!ownerRows.has(key)) ownerRows.set(key, {
      ownerUserId: key, opportunitiesCreated: 0, demosHeld: 0, wins: 0, losses: 0,
      wonMrr: currencyTotals(), wonMrrUnknownCount: 0, responseMinutes: [], awaitingResponseCount: 0,
      responseUnknownCount: 0, followUp: { dueCount: 0, completedOnTime: 0, completedLate: 0, overdue: 0, cancelled: 0 }
    });
    return ownerRows.get(key);
  }
  for (const record of safeRecords) {
    if (inRange(record.createdAt, from, to)) {
      const row = ownerRow(record.stageHistory[0]?.ownerUserId ?? record.ownerUserId);
      row.opportunitiesCreated++;
      const contacted = record.stageHistory.find(event => event.to === 'contacted' && event.at >= record.createdAt && event.at <= asOf);
      if (contacted) ownerRow(contacted.ownerUserId).responseMinutes.push((Date.parse(contacted.at) - Date.parse(record.createdAt)) / 60000);
      else if (record.stage === 'new') row.awaitingResponseCount++;
      else row.responseUnknownCount++;
    }
    for (const event of record.stageHistory) {
      if (!inRange(event.at, from, to) || event.at > asOf) continue;
      const row = ownerRow(event.ownerUserId);
      if (event.to === 'demo_held') row.demosHeld++;
      if (event.to === 'won') {
        row.wins++;
        if (event.expectedMrrMinor == null || !event.currency) row.wonMrrUnknownCount++;
        else row.wonMrr.add(event.currency, event.expectedMrrMinor);
      }
      if (event.to === 'lost') row.losses++;
    }
    for (const followUp of record.followUps) {
      if (!inRange(followUp.dueAt, from, to) || followUp.dueAt > asOf) continue;
      const row = ownerRow(followUp.ownerUserId);
      if (followUp.status === 'cancelled') { row.followUp.cancelled++; continue; }
      row.followUp.dueCount++;
      if (followUp.status === 'completed') {
        if (followUp.completedAt <= followUp.dueAt) row.followUp.completedOnTime++;
        else row.followUp.completedLate++;
      } else if (followUp.dueAt <= asOf) row.followUp.overdue++;
    }
  }
  const leaderboard = [...ownerRows.values()].map(row => {
    const decided = row.wins + row.losses;
    const trackedFollowUps = row.followUp.completedOnTime + row.followUp.completedLate + row.followUp.overdue;
    const result = {
      ownerUserId: row.ownerUserId,
      opportunitiesCreated: row.opportunitiesCreated,
      demosHeld: row.demosHeld,
      wins: row.wins,
      losses: row.losses,
      winRate: decided ? Math.round(row.wins / decided * 10000) / 100 : null,
      wonMrr: row.wonMrr.rows(),
      wonMrrUnknownCount: row.wonMrrUnknownCount,
      responseTime: {
        respondedCount: row.responseMinutes.length,
        awaitingResponseCount: row.awaitingResponseCount,
        unknownCount: row.responseUnknownCount,
        averageMinutes: row.responseMinutes.length ? Math.round(row.responseMinutes.reduce((sum, value) => sum + value, 0) / row.responseMinutes.length * 100) / 100 : null
      },
      followUpReliability: {
        ...row.followUp,
        rate: trackedFollowUps ? Math.round(row.followUp.completedOnTime / trackedFollowUps * 10000) / 100 : null
      }
    };
    return result;
  }).sort((a, b) => b.wins - a.wins || b.demosHeld - a.demosHeld || a.ownerUserId.localeCompare(b.ownerUserId));
  return deepFreeze({
    period: { from, to, asOf },
    cohortSize: cohort.length,
    funnel,
    attribution: {
      source: breakdown(cohort, row => row.attribution?.source),
      medium: breakdown(cohort, row => row.attribution?.medium),
      campaign: breakdown(cohort, row => row.attribution?.campaign),
      plan: breakdown(cohort, row => row.plan)
    },
    pipeline: { count: pipeline.length, expectedMrr: pipelineMrr.rows(), expectedMrrUnknownCount: pipelineMrrUnknownCount },
    overdue: { count: overdueItems.length, items: overdueItems },
    leaderboard
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function safeDisplayOpportunity(record) {
  checkRecord(record);
  const text = value => value == null ? null : escapeHtml(value);
  return deepFreeze({
    id: text(record.id),
    companyName: text(record.companyName),
    contactName: text(record.contactName),
    email: text(record.email),
    phone: text(record.phone),
    ownerUserId: text(record.ownerUserId),
    stage: text(record.stage),
    attribution: Object.fromEntries(Object.entries(record.attribution).map(([key, value]) => [key, text(value)])),
    plan: text(record.plan),
    expectedMrrMinor: record.expectedMrrMinor,
    currency: text(record.currency),
    nextAction: text(record.nextAction),
    nextActionDueAt: text(record.nextActionDueAt),
    linkedCompanyId: text(record.linkedCompanyId),
    outcome: text(record.outcome),
    lossReason: text(record.lossReason),
    notes: record.notes.map(note => ({ id: text(note.id), text: text(note.text), at: text(note.at), authorUserId: text(note.authorUserId) }))
  });
}

module.exports = {
  STAGES,
  CLOSED_STAGES,
  TRANSITIONS,
  UNKNOWN_BUCKET,
  UNASSIGNED_OWNER,
  GrowthDomainError,
  createOpportunity,
  updateOpportunity,
  transitionOpportunity,
  setNextAction,
  completeNextAction,
  cancelNextAction,
  addNote,
  findDuplicates,
  listOpportunities,
  growthMetrics,
  escapeHtml,
  safeDisplayOpportunity
};
