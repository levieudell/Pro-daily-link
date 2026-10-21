'use strict';

const assert = require('node:assert/strict');
const {
  STAGES,
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
} = require('./growth-domain');

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof GrowthDomainError && error.code === code, `Expected ${code}`);
}

function make(input = {}, context = {}, records = []) {
  const id = context.id || `opp-${Math.random().toString(36).slice(2, 10)}`;
  const result = createOpportunity(records, { companyName: 'Acme Concrete', ...input }, {
    now: '2026-10-01T16:00:00.000Z',
    actorUserId: 'platform-owner',
    idGenerator: () => id,
    ...context
  });
  assert.equal(result.status, 'created');
  return result.opportunity;
}

// The workflow is explicit, terminal outcomes do not reopen implicitly, and
// callers cannot mutate the policy table.
assert.deepEqual(STAGES, ['new', 'contacted', 'qualified', 'demo_scheduled', 'demo_held', 'proposal', 'won', 'lost']);
assert.deepEqual(TRANSITIONS.won, []);
assert.equal(Object.isFrozen(STAGES), true);
assert.equal(Object.isFrozen(TRANSITIONS.demo_held), true);

{ // Creation normalizes contact/attribution data and keeps unknowns genuinely unknown.
  const result = createOpportunity([], {
    companyName: '  <b>North Star</b>  ',
    contactName: '  Sam   Rivera ',
    email: 'SAM@Example.COM',
    phone: '(503) 555-0199',
    source: ' Paid Search ',
    medium: ' cpc ',
    campaign: 'Fall launch',
    referrer: 'https://search.example/path?q=pdl',
    landingPage: '/pricing?plan=growth',
    plan: null,
    expectedMrrMinor: 19900,
    currency: 'USD',
    nextAction: 'Call about the 30-person crew',
    nextActionDueAt: '2026-10-02T17:00:00-07:00',
    note: '<script>alert("stored as plain text")</script>\r\nNeeds Spanish onboarding.'
  }, {
    now: '2026-10-01T15:00:00-07:00', actorUserId: 'owner-1', idempotencyKey: 'web-form-42', idGenerator: () => 'opp-safe'
  });
  const row = result.opportunity;
  assert.equal(result.status, 'created');
  assert.equal(row.id, 'opp-safe');
  assert.equal(row.companyName, '<b>North Star</b>');
  assert.equal(row.contactName, 'Sam Rivera');
  assert.equal(row.email, 'sam@example.com');
  assert.equal(row.attribution.source, 'Paid Search');
  assert.equal(row.attribution.referrer, 'https://search.example/path?q=pdl');
  assert.equal(row.attribution.landingPage, '/pricing?plan=growth');
  assert.equal(row.currency, 'usd');
  assert.equal(row.nextActionDueAt, '2026-10-03T00:00:00.000Z');
  assert.equal(row.outcome, null);
  assert.equal(row.lossReason, null);
  assert.equal(row.stageHistory.length, 1);
  assert.equal(row.followUps.length, 1);
  assert.equal(row.notes[0].text.includes('<script>'), true, 'Stored data remains lossless plain text');
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Object.isFrozen(row.stageHistory), true);
  assert.throws(() => { row.stage = 'won'; }, TypeError);
  assert.match(safeDisplayOpportunity(row).companyName, /&lt;b&gt;North Star&lt;\/b&gt;/);
  assert.match(safeDisplayOpportunity(row).notes[0].text, /&lt;script&gt;/);
  assert.equal(escapeHtml(`A&B <tag> "quote" 'single'`), 'A&amp;B &lt;tag&gt; &quot;quote&quot; &#39;single&#39;');
}

{ // Strict validation rejects mass assignment, executable URLs, malformed contact data and incomplete money/actions.
  expectCode(() => createOpportunity([], { companyName: 'Acme', stage: 'won' }), 'unexpected_field');
  expectCode(() => createOpportunity([], { companyName: 'Acme', email: 'not-an-email' }), 'invalid_email');
  expectCode(() => createOpportunity([], { companyName: 'Acme', phone: '123' }), 'invalid_phone');
  expectCode(() => createOpportunity([], { companyName: 'Acme', referrer: 'javascript:alert(1)' }), 'invalid_url');
  expectCode(() => createOpportunity([], { companyName: 'Acme', landingPage: '//evil.example' }), 'invalid_url');
  expectCode(() => createOpportunity([], { companyName: 'Acme', expectedMrrMinor: 9900 }), 'invalid_currency');
  expectCode(() => createOpportunity([], { companyName: 'Acme', expectedMrrMinor: 99.5, currency: 'usd' }), 'invalid_mrr');
  expectCode(() => createOpportunity([], { companyName: 'Acme', ownerUserId: UNASSIGNED_OWNER }), 'reserved_owner_id');
  expectCode(() => createOpportunity([], { companyName: 'Acme', nextAction: 'Call' }), 'incomplete_next_action');
  expectCode(() => createOpportunity([], { source: 'referral' }), 'missing_identity');
  expectCode(() => createOpportunity([], { companyName: 'Acme' }, { now: 'October 1' }), 'invalid_timestamp');
}

{ // Idempotency never creates a second record and never accepts a different payload under the same key.
  const input = { companyName: 'Idempotent Builders', email: 'same@example.com', source: 'website' };
  const context = { now: '2026-10-01T16:00:00.000Z', actorUserId: 'owner-1', idempotencyKey: 'request-123', idGenerator: () => 'opp-idem' };
  const first = createOpportunity([], input, context).opportunity;
  const replay = createOpportunity([first], input, { ...context, idGenerator: () => 'must-not-run' });
  assert.equal(replay.status, 'idempotent');
  assert.equal(replay.created, false);
  assert.equal(replay.opportunity.id, first.id);
  assert.notEqual(replay.opportunity, first, 'Replay returns a safe copy rather than freezing caller state');
  expectCode(() => createOpportunity([first], { ...input, companyName: 'Different Builder' }, context), 'idempotency_conflict');
}

{ // Duplicate detection blocks exact active matches, reports probable matches, allows deliberate overrides, and ignores closed history.
  const original = make({ contactName: 'Alex Jones', email: 'alex@example.com', phone: '503-555-0123' }, { id: 'opp-original' });
  assert.deepEqual(findDuplicates([original], { companyName: 'Other', email: 'ALEX@example.com' }), [{ id: 'opp-original', reasons: ['email'], certainty: 'exact' }]);
  expectCode(() => findDuplicates([original], { companyName: 'Other', email: 'alex@example.com', stage: 'won' }), 'unexpected_field');
  const blocked = createOpportunity([original], { companyName: 'Other', email: 'alex@example.com' }, { idGenerator: () => 'opp-blocked' });
  assert.equal(blocked.status, 'duplicate');
  assert.equal(blocked.opportunity, null);
  const probable = createOpportunity([original], { companyName: ' acme concrete ', contactName: ' ALEX   JONES ' }, { idGenerator: () => 'opp-probable' });
  assert.equal(probable.status, 'created');
  assert.equal(probable.duplicates[0].certainty, 'probable');
  const deliberate = createOpportunity([original], { companyName: 'Other', phone: '5035550123' }, { idGenerator: () => 'opp-deliberate', allowExactDuplicate: true });
  assert.equal(deliberate.status, 'created');
  const closed = transitionOpportunity(original, 'lost', { now: '2026-10-02T00:00:00.000Z', lossReason: 'No budget' });
  assert.equal(createOpportunity([closed], { companyName: 'Other', email: 'alex@example.com' }, { idGenerator: () => 'opp-new-cycle' }).status, 'created');
}

{ // Updates are copy-on-write, revision guarded, audited, identity preserving and unable to overwrite histories/outcomes.
  const original = make({ ownerUserId: 'sales-1', source: 'referral', expectedMrrMinor: 9900, currency: 'usd' }, { id: 'opp-update' });
  const updated = updateOpportunity(original, {
    ownerUserId: 'sales-2', source: 'Partner', medium: 'introduction', plan: 'Growth', linkedCompanyId: 'company-7', expectedMrrMinor: 19900
  }, { now: '2026-10-01T17:00:00.000Z', actorUserId: 'manager-1', expectedVersion: 1 });
  assert.equal(updated.id, original.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.ownerUserId, 'sales-2');
  assert.equal(updated.attribution.source, 'Partner');
  assert.equal(updated.expectedMrrMinor, 19900);
  assert.equal(original.ownerUserId, 'sales-1');
  assert.equal(original.history.length, 1);
  assert.equal(updated.history.at(-1).type, 'updated');
  assert.deepEqual(updated.history.at(-1).details.before.ownerUserId, 'sales-1');
  expectCode(() => updateOpportunity(updated, { stage: 'won' }), 'unexpected_field');
  expectCode(() => updateOpportunity(updated, { ownerUserId: 'sales-3' }, { expectedVersion: 1 }), 'revision_conflict');
  expectCode(() => updateOpportunity(updated, { ownerUserId: 'sales-2' }), 'no_change');
  expectCode(() => updateOpportunity(updated, { ownerUserId: 'sales-3' }, { now: '2026-09-01T00:00:00.000Z' }), 'invalid_chronology');
}

{ // Stage transitions append snapshots, require a loss reason and keep terminal outcomes terminal.
  const lead = make({ ownerUserId: 'sales-1', expectedMrrMinor: 39900, currency: 'usd' }, { id: 'opp-stage' });
  expectCode(() => transitionOpportunity(lead, 'won', { now: '2026-10-02T00:00:00.000Z' }), 'invalid_transition');
  const contacted = transitionOpportunity(lead, 'contacted', { now: '2026-10-01T17:00:00.000Z', actorUserId: 'sales-1' });
  const qualified = transitionOpportunity(contacted, 'qualified', { now: '2026-10-02T17:00:00.000Z', reason: 'Team has 24 field users' });
  const demo = transitionOpportunity(qualified, 'demo_held', { now: '2026-10-03T17:00:00.000Z' });
  const proposal = transitionOpportunity(demo, 'proposal', { now: '2026-10-04T17:00:00.000Z' });
  const won = transitionOpportunity(proposal, 'won', { now: '2026-10-05T17:00:00.000Z' });
  assert.equal(won.outcome, 'won');
  assert.equal(won.outcomeAt, '2026-10-05T17:00:00.000Z');
  assert.equal(won.stageHistory.length, 6);
  assert.equal(won.stageHistory.at(-1).expectedMrrMinor, 39900, 'Won MRR is snapshotted, not inferred later');
  assert.equal(lead.stageHistory.length, 1);
  expectCode(() => transitionOpportunity(won, 'proposal', { now: '2026-10-06T00:00:00.000Z' }), 'invalid_transition');
  expectCode(() => transitionOpportunity(qualified, 'lost', { now: '2026-10-03T00:00:00.000Z' }), 'loss_reason_required');
  const lost = transitionOpportunity(qualified, 'lost', { now: '2026-10-03T00:00:00.000Z', lossReason: 'Chose another product' });
  assert.equal(lost.lossReason, 'Chose another product');
  expectCode(() => transitionOpportunity(contacted, 'qualified', { now: '2026-10-02T00:00:00.000Z', lossReason: 'Not applicable' }), 'unexpected_loss_reason');
}

{ // Notes and follow-ups have an immutable, auditable lifecycle; pending work cannot be silently overwritten.
  const lead = make({ nextAction: 'Call estimator', nextActionDueAt: '2026-10-02T17:00:00.000Z' }, { id: 'opp-actions' });
  expectCode(() => setNextAction(lead, { description: 'Send proposal', dueAt: '2026-10-03T17:00:00.000Z' }), 'pending_action_exists');
  const completed = completeNextAction(lead, { now: '2026-10-02T16:00:00.000Z', actorUserId: 'sales-1', expectedVersion: 1 });
  assert.equal(completed.followUps[0].status, 'completed');
  assert.equal(completed.nextAction, null);
  const next = setNextAction(completed, { description: 'Send proposal', dueAt: '2026-10-04T17:00:00.000Z' }, { now: '2026-10-02T18:00:00.000Z' });
  assert.equal(next.followUps.length, 2);
  expectCode(() => cancelNextAction(next, { now: '2026-10-03T00:00:00.000Z' }), 'required_field');
  const cancelled = cancelNextAction(next, { now: '2026-10-03T00:00:00.000Z', reason: 'Customer requested next month' });
  assert.equal(cancelled.followUps[1].status, 'cancelled');
  const noted = addNote(cancelled, 'Customer asked for <strong>Spanish</strong> training.\nFollow up Monday.', { now: '2026-10-03T01:00:00.000Z', actorUserId: 'sales-1' });
  assert.equal(noted.notes.length, 1);
  assert.equal(noted.history.at(-1).type, 'note_added');
  assert.match(safeDisplayOpportunity(noted).notes[0].text, /&lt;strong&gt;/);
}

{ // Replacing a pending follow-up preserves the cancelled record and requires an explanation.
  const lead = make({ nextAction: 'Old action', nextActionDueAt: '2026-10-03T00:00:00.000Z' }, { id: 'opp-replace' });
  const replaced = setNextAction(lead, { description: 'Correct action', dueAt: '2026-10-04T00:00:00.000Z', replaceReason: 'Wrong contact method' }, { now: '2026-10-02T00:00:00.000Z' });
  assert.equal(replaced.followUps[0].status, 'cancelled');
  assert.equal(replaced.followUps[0].cancellationReason, 'Wrong contact method');
  assert.equal(replaced.followUps[1].status, 'pending');
}

{ // Lists expose honest filters, unknown/unassigned buckets, deterministic ordering and safe pagination without mutating inputs.
  let alpha = make({ contactName: 'Alpha Person', ownerUserId: 'sales-1', source: 'Referral', note: 'Needs concrete production tracking', nextAction: 'Call', nextActionDueAt: '2026-10-02T00:00:00.000Z' }, { id: 'opp-alpha' });
  let beta = make({ companyName: 'Beta Excavation', ownerUserId: null, source: null }, { id: 'opp-beta', now: '2026-10-01T17:00:00.000Z' });
  let gamma = make({ companyName: 'Gamma Civil', ownerUserId: 'sales-2', source: 'Website', nextAction: 'Demo', nextActionDueAt: '2026-10-10T00:00:00.000Z' }, { id: 'opp-gamma', now: '2026-10-01T18:00:00.000Z' });
  beta = transitionOpportunity(beta, 'lost', { now: '2026-10-02T00:00:00.000Z', lossReason: 'Too early' });
  const records = [gamma, alpha, beta];
  assert.deepEqual(listOpportunities(records, { ownerUserId: UNASSIGNED_OWNER }).items.map(row => row.id), ['opp-beta']);
  assert.deepEqual(listOpportunities(records, { source: UNKNOWN_BUCKET }).items.map(row => row.id), ['opp-beta']);
  assert.deepEqual(listOpportunities(records, { search: 'production tracking' }).items.map(row => row.id), ['opp-alpha']);
  assert.deepEqual(listOpportunities(records, { due: 'overdue', asOf: '2026-10-05T00:00:00.000Z' }).items.map(row => row.id), ['opp-alpha']);
  assert.deepEqual(listOpportunities(records, { stages: ['lost'] }).items.map(row => row.id), ['opp-beta']);
  assert.deepEqual(listOpportunities(records, { sort: 'company_asc', limit: 2, offset: 1 }).items.map(row => row.id), ['opp-beta', 'opp-gamma']);
  assert.equal(Object.isFrozen(records[0]), true, 'Domain-created inputs stay immutable');
  const mutableCopy = structuredClone(alpha);
  listOpportunities([mutableCopy]);
  assert.equal(Object.isFrozen(mutableCopy), false, 'Listing does not freeze or mutate caller-owned records');
  expectCode(() => listOpportunities(records, { stages: ['closed'] }), 'invalid_stage_filter');
  expectCode(() => listOpportunities(records, { limit: 201 }), 'invalid_pagination');
}

{ // Metrics count only evidenced events/amounts, preserve unknowns, snapshot ownership, and never divide by zero.
  const records = [];
  let a = make({ companyName: 'A Co', ownerUserId: 'sales-1', source: 'Google', medium: 'cpc', campaign: 'October', plan: 'Growth', expectedMrrMinor: 19900, currency: 'usd', nextAction: 'First call', nextActionDueAt: '2026-10-02T17:00:00.000Z' }, { id: 'metric-a', now: '2026-10-01T16:00:00.000Z' });
  a = transitionOpportunity(a, 'contacted', { now: '2026-10-01T17:00:00.000Z', actorUserId: 'sales-1' });
  a = completeNextAction(a, { now: '2026-10-02T16:00:00.000Z', actorUserId: 'sales-1' });
  a = transitionOpportunity(a, 'qualified', { now: '2026-10-02T18:00:00.000Z' });
  a = transitionOpportunity(a, 'demo_held', { now: '2026-10-03T18:00:00.000Z' });
  a = transitionOpportunity(a, 'proposal', { now: '2026-10-04T18:00:00.000Z' });
  a = transitionOpportunity(a, 'won', { now: '2026-10-05T18:00:00.000Z' });
  records.push(a);

  let b = make({ companyName: 'B Co', ownerUserId: null, source: null, medium: null, campaign: null, plan: null, nextAction: 'Qualify', nextActionDueAt: '2026-10-02T12:00:00.000Z' }, { id: 'metric-b', now: '2026-10-01T17:00:00.000Z' });
  b = transitionOpportunity(b, 'qualified', { now: '2026-10-02T17:00:00.000Z' }); // No contacted event: response remains unknown.
  b = transitionOpportunity(b, 'lost', { now: '2026-10-04T17:00:00.000Z', lossReason: 'No decision' });
  records.push(b);

  let c = make({ companyName: 'C Co', ownerUserId: 'sales-1', source: 'Google', medium: null, campaign: null, plan: 'Enterprise', expectedMrrMinor: null, currency: null, nextAction: 'Book demo', nextActionDueAt: '2026-10-03T12:00:00.000Z' }, { id: 'metric-c', now: '2026-10-01T18:00:00.000Z' });
  c = completeNextAction(c, { now: '2026-10-04T12:00:00.000Z', actorUserId: 'sales-1' }); // late
  c = transitionOpportunity(c, 'qualified', { now: '2026-10-04T13:00:00.000Z' });
  c = transitionOpportunity(c, 'demo_held', { now: '2026-10-04T14:00:00.000Z' });
  c = transitionOpportunity(c, 'won', { now: '2026-10-04T15:00:00.000Z' });
  records.push(c);

  // Created before the cohort but closed inside it: should affect outcomes, not cohort funnel.
  let d = make({ companyName: 'D Co', ownerUserId: 'sales-2', source: 'Partner', expectedMrrMinor: 50000, currency: 'usd' }, { id: 'metric-d', now: '2026-09-30T18:00:00.000Z' });
  d = transitionOpportunity(d, 'qualified', { now: '2026-10-01T19:00:00.000Z' });
  d = transitionOpportunity(d, 'demo_held', { now: '2026-10-02T19:00:00.000Z' });
  d = transitionOpportunity(d, 'won', { now: '2026-10-03T19:00:00.000Z' });
  records.push(d);

  // Active, uncontacted and overdue: appears in pipeline and explicit awaiting bucket.
  const e = make({ companyName: 'E Co', ownerUserId: 'sales-2', source: 'Website', nextAction: 'Respond', nextActionDueAt: '2026-10-05T00:00:00.000Z' }, { id: 'metric-e', now: '2026-10-02T16:00:00.000Z' });
  records.push(e);

  const metrics = growthMetrics(records, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', asOf: '2026-10-06T00:00:00.000Z' });
  assert.equal(metrics.cohortSize, 4);
  assert.deepEqual(metrics.funnel, { new: 4, contacted: 1, qualified: 3, demo_scheduled: 0, demo_held: 2, proposal: 1, won: 2, lost: 1 });
  assert.deepEqual(metrics.attribution.source, [{ bucket: 'google', count: 2 }, { bucket: 'unknown', count: 1 }, { bucket: 'website', count: 1 }]);
  assert.deepEqual(metrics.attribution.medium, [{ bucket: 'unknown', count: 3 }, { bucket: 'cpc', count: 1 }]);
  assert.equal(metrics.pipeline.count, 1);
  assert.deepEqual(metrics.pipeline.expectedMrr, []);
  assert.equal(metrics.pipeline.expectedMrrUnknownCount, 1);
  assert.equal(metrics.overdue.count, 1);
  assert.deepEqual(metrics.overdue.items[0], { id: 'metric-e', ownerUserId: 'sales-2', dueAt: '2026-10-05T00:00:00.000Z' });

  const sales1 = metrics.leaderboard.find(row => row.ownerUserId === 'sales-1');
  assert.equal(sales1.opportunitiesCreated, 2);
  assert.equal(sales1.demosHeld, 2);
  assert.equal(sales1.wins, 2);
  assert.deepEqual(sales1.wonMrr, [{ currency: 'usd', amountMinor: 19900 }]);
  assert.equal(sales1.wonMrrUnknownCount, 1);
  assert.equal(sales1.winRate, 100);
  assert.deepEqual(sales1.responseTime, { respondedCount: 1, awaitingResponseCount: 0, unknownCount: 1, averageMinutes: 60 });
  assert.deepEqual(sales1.followUpReliability, { dueCount: 2, completedOnTime: 1, completedLate: 1, overdue: 0, cancelled: 0, rate: 50 });

  const unassigned = metrics.leaderboard.find(row => row.ownerUserId === UNASSIGNED_OWNER);
  assert.equal(unassigned.losses, 1);
  assert.equal(unassigned.wins, 0);
  assert.equal(unassigned.winRate, 0);
  assert.equal(unassigned.followUpReliability.overdue, 1);
  assert.equal(unassigned.responseTime.unknownCount, 1);

  const sales2 = metrics.leaderboard.find(row => row.ownerUserId === 'sales-2');
  assert.equal(sales2.opportunitiesCreated, 1);
  assert.equal(sales2.demosHeld, 1);
  assert.equal(sales2.wins, 1);
  assert.deepEqual(sales2.wonMrr, [{ currency: 'usd', amountMinor: 50000 }]);
  assert.equal(sales2.responseTime.averageMinutes, null);
  assert.equal(sales2.responseTime.awaitingResponseCount, 1);
  assert.equal(sales2.followUpReliability.rate, 0);
  assert.equal(Object.isFrozen(metrics.leaderboard), true);

  expectCode(() => growthMetrics(records, { from: '2026-10-06T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', asOf: '2026-10-06T00:00:00.000Z' }), 'invalid_period');
  expectCode(() => growthMetrics(records, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z', asOf: '2026-10-06T00:00:00.000Z' }), 'invalid_period');
}

{ // Outcome, response and money snapshots stay with the owner/value evidenced at the event, even after later edits.
  let lead = make({ ownerUserId: 'sales-original', expectedMrrMinor: 10000, currency: 'usd' }, { id: 'metric-snapshot', now: '2026-10-01T10:00:00.000Z' });
  lead = updateOpportunity(lead, { ownerUserId: 'sales-responder' }, { now: '2026-10-01T10:30:00.000Z' });
  lead = transitionOpportunity(lead, 'contacted', { now: '2026-10-01T11:00:00.000Z' });
  lead = transitionOpportunity(lead, 'qualified', { now: '2026-10-01T12:00:00.000Z' });
  lead = transitionOpportunity(lead, 'demo_held', { now: '2026-10-01T13:00:00.000Z' });
  lead = transitionOpportunity(lead, 'won', { now: '2026-10-01T14:00:00.000Z' });
  lead = updateOpportunity(lead, { expectedMrrMinor: 99900 }, { now: '2026-10-01T15:00:00.000Z' });
  const metrics = growthMetrics([lead], { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', asOf: '2026-10-02T00:00:00.000Z' });
  const creator = metrics.leaderboard.find(row => row.ownerUserId === 'sales-original');
  const responder = metrics.leaderboard.find(row => row.ownerUserId === 'sales-responder');
  assert.equal(creator.opportunitiesCreated, 1);
  assert.equal(creator.responseTime.respondedCount, 0);
  assert.equal(responder.responseTime.respondedCount, 1);
  assert.equal(responder.responseTime.averageMinutes, 60);
  assert.deepEqual(responder.wonMrr, [{ currency: 'usd', amountMinor: 10000 }], 'Won MRR uses the close-time snapshot, not a later edit');
}

{ // Empty metrics return null rates and empty currency lists rather than fake zeros with implied precision.
  const empty = growthMetrics([], { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', asOf: '2026-10-02T00:00:00.000Z' });
  assert.equal(empty.cohortSize, 0);
  assert.deepEqual(empty.pipeline.expectedMrr, []);
  assert.deepEqual(empty.leaderboard, []);
  assert.deepEqual(empty.funnel, Object.fromEntries(STAGES.map(stage => [stage, 0])));
}

console.log('Growth domain: validation, immutable workflow, dedupe/idempotency, attribution, follow-ups, safe display, filters, funnel, overdue and outcome leaderboard checks passed.');
