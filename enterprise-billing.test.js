'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const enterprise=require('./enterprise-billing');
const {fixture,input,epoch,env,actor,COMPANY,OTHER}=require('./fixtures/enterprise-billing');
test('explicit commercial draft is inert, immutable once issued, and idempotent', () => {
  const f = fixture(); assert.equal(f.db.company.plan, 'starter'); assert.equal(f.quote.status, 'draft');
  assert.deepEqual(enterprise.list(f.db.company, true), []); assert.equal(enterprise.access(f.db.company), null);
  assert.equal(enterprise.createDraft(f.db, input(), actor, epoch).id, f.quote.id);
  assert.throws(() => enterprise.createDraft(f.db, input({ totalAmount: 90000 }), actor, epoch), /request ID/);
  for (const bad of [{ totalAmount: 0 }, { totalAmount: 100.5 }, { currency: 'jpy' }, { limits: {} }, { features: {} }, { term: 'monthly' }, { taxTreatment: '' }, { refundPolicy: '' }]) {
    assert.throws(() => enterprise.createDraft(f.db, input({ ...bad, requestId: 'synthetic_request_0002' }), actor, epoch));
  }
  assert.throws(() => enterprise.issue(f.db, f.quote.id, { revision: 1 }, actor, epoch), /explicitly approve/);
  f.approve(); assert.throws(() => enterprise.editDraft(f.db, f.quote.id, { ...input(), revision: 1 }, actor, epoch), /Only an unissued/);
  assert.equal(enterprise.list(f.db.company, true)[0].status, 'offered');
  assert.ok(!Object.hasOwn(enterprise.publicQuote(f.quote), 'audit'));
});

test('default-off configuration, owner acceptance, amount and usage safeguards', async () => {
  const f = fixture(); f.approve();
  const service = enterprise.createService({ client: f.client, persist: async () => {}, env: {} });
  await assert.rejects(service.checkout(f.db, f.quote.id, {}, actor), /not enabled/);
  await assert.rejects(f.service.checkout(f.db, f.quote.id, { revision: 1, termsAccepted: true, termsDigest: 'forged' }, actor), /Accept this exact/);
  f.db.users = Array.from({ length: 13 }, () => ({ status: 'Active' }));
  await assert.rejects(f.pay(), /below current/); assert.equal(f.creates(), 0);
});

test('existing subscriptions, founder, complimentary, demo and overlapping offers are not replaced', () => {
  for (const extra of [{ stripeSubscriptionId: 'sub_existing' }, { pendingCheckout: { id: 'cs_existing' } }, { founder: { requested: true } }, { billingExempt: true }, { demo: true }]) {
    const f = fixture(); Object.assign(f.db.company, extra); assert.throws(f.approve, /reviewed billing migration/);
  }
  const f = fixture(); f.approve();
  const q = enterprise.createDraft(f.db, input({ requestId: 'synthetic_request_0002' }), actor, epoch);
  assert.throws(() => enterprise.issue(f.db, q.id, { revision: 1, termsDigest: q.termsDigest, commercialApproved: true }, actor, epoch), /other open/);
});

test('checkout is saved before Stripe, stable on uncertain retries, no invoice or subscription', async () => {
  const f = fixture(); f.approve(); f.failSave(true);
  await assert.rejects(f.pay(), /storage/); assert.equal(f.creates(), 0);
  f.failSave(false); f.failCreate(true); await assert.rejects(f.pay(), /connection failure/);
  f.failCreate(false); await f.pay(); await f.pay();
  assert.equal(f.creates(), 2); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[0].params.mode, 'payment'); assert.equal(f.calls[0].params.payment_method_types, undefined);
  assert.equal(f.calls[0].params.customer_email, undefined); assert.equal(f.calls[0].params.subscription_data, undefined);
  assert.equal(f.quote.acceptedBy, '1'); assert.equal(f.db.company.plan, 'starter');
  f.failSave(true); await assert.rejects(f.pay(), /storage/);
});

test('uncertain create after idempotency safety window cannot create a second payment', async () => {
  const f = fixture(); f.approve(); f.failCreate(true); await assert.rejects(f.pay());
  f.clock(epoch + 24 * 3600000); f.failCreate(false);
  await assert.rejects(f.pay(), /earlier checkout result needs review/); assert.equal(f.creates(), 1);
  await assert.rejects(f.service.cancel(f.db, f.quote.id, { revision: 1 }, actor), /manual payment review/);
});

test('only verified paid state activates correct limits and preserves annual dates across replays', async () => {
  const f = fixture(); f.approve(); await f.pay();
  f.session().status = 'complete'; await f.process(); assert.equal(f.quote.status, 'processing'); assert.equal(f.db.company.plan, 'starter');
  f.paid(); await f.process(f.event('checkout.session.async_payment_succeeded'));
  assert.equal(f.quote.status, 'paid'); assert.equal(f.db.company.plan, 'enterprise');
  assert.equal(enterprise.access(f.db.company, epoch).locked, false);
  assert.deepEqual(enterprise.plan(f.db.company), { name: 'Enterprise', price: null, annualPrice: 1234, maxUsers: 12, maxProjects: null });
  assert.equal(f.db.company.features.timeCards, true); assert.equal(f.db.company.features.templates, false);
  assert.equal(f.db.company.nextBillingAt, null); assert.equal(f.quote.endsAt, '2027-10-05T12:00:00.000Z');
  f.clock(epoch + 1000000); await f.process(); assert.equal(f.quote.startsAt, '2026-10-05T12:00:00.000Z'); assert.equal(f.quote.webhookEvents.length, 1);
  assert.equal(enterprise.access(f.db.company, Date.parse(f.quote.endsAt)).status, 'Review due');
  assert.equal(enterprise.annualEnd('2028-02-29T12:00:00.000Z'), '2029-02-28T12:00:00.000Z');
});

test('forged mapping, mode, totals, currency and payment evidence fail closed', async () => {
  for (const mutate of [s => s.client_reference_id = OTHER, s => s.metadata.company_id = OTHER,
    s => s.metadata.terms_digest = 'forged', s => s.livemode = true, s => s.amount_total--,
    s => s.currency = 'eur', s => s.payment_intent.amount_received--, s => s.payment_intent.latest_charge.paid = false,
    s => s.payment_intent.latest_charge.payment_intent = 'pi_wrong']) {
    const f = fixture(); f.approve(); await f.pay(); f.paid(); const event = f.event(); mutate(f.session());
    await assert.rejects(f.process(event)); assert.equal(f.db.company.plan, 'starter');
  }
  const f = fixture(); f.approve(); await f.pay(); f.paid();
  const event = f.event(); event.data.object.id = 'cs_other'; await assert.rejects(f.process(event), /saved checkout/);
});

test('customer binding, refund/dispute current state and out-of-order events cannot restore access', async () => {
  const f = fixture(); f.db.company.stripeCustomerId = 'cus_synthetic'; f.approve(); await f.pay(); f.paid(); await f.process();
  f.session().customer = 'cus_other'; await assert.rejects(f.process(), /company quote/); f.session().customer = 'cus_synthetic';
  f.session().payment_intent.latest_charge.amount_refunded = 1;
  await f.process(f.event('charge.refunded', f.session().payment_intent.latest_charge)); assert.equal(f.quote.status, 'payment_review');
  await f.process(); assert.equal(enterprise.access(f.db.company, epoch).locked, true);
  f.session().payment_intent.latest_charge.amount_refunded = f.quote.totalAmount;
  await f.process(); assert.equal(f.quote.status, 'refunded');
  f.session().payment_intent.latest_charge.amount_refunded = 0; f.session().payment_intent.latest_charge.disputed = true;
  f.disputes.push({ status: 'under_review' }); await f.process(f.event('charge.dispute.created', { charge: 'ch_synthetic' })); assert.equal(f.quote.status, 'payment_review');
  f.disputes[0].status = 'won'; await f.process(f.event('charge.dispute.closed', { charge: 'ch_synthetic' })); assert.equal(f.quote.status, 'paid');
});

test('cancel expires unpaid checkout; paid and processing cancel require review; failed payment stays inactive', async () => {
  const f = fixture(); f.approve(); await f.pay(); await f.service.cancel(f.db, f.quote.id, { revision: 1 }, actor);
  assert.equal(f.session().status, 'expired'); assert.equal(f.quote.status, 'cancelled'); await assert.rejects(f.pay(), /not available/);
  f.paid(); await f.process(); assert.equal(f.quote.status, 'payment_review'); assert.equal(enterprise.access(f.db.company, epoch).locked, true);
  const g = fixture(); g.approve(); await g.pay(); g.session().status = 'complete';
  await g.process(g.event('checkout.session.async_payment_failed')); assert.equal(g.quote.status, 'payment_failed');
  await assert.rejects(g.service.cancel(g.db, g.quote.id, { revision: 1 }, actor), /complete or processing/);
  assert.equal(g.db.company.plan, 'starter');
});

test('a durable webhook retry re-saves even a duplicate event', async () => {
  const f = fixture(); f.approve(); await f.pay(); f.paid(); f.failSave(true); await assert.rejects(f.process(), /storage/);
  const before = f.saves(); f.failSave(false); await f.process(); assert.equal(f.saves(), before + 1); assert.equal(f.quote.webhookEvents.length, 1);
});

test('a reviewed new annual term cannot be replaced by late events for the old term', async () => {
  const f = fixture(); f.approve(); await f.pay(); f.paid(); await f.process();
  const oldId = f.quote.id, nextStart = Date.parse(f.quote.endsAt) + 1000;
  f.clock(nextStart);
  const next = enterprise.createDraft(f.db, input({ requestId: 'synthetic_renewal_0002', expiresAt: new Date(nextStart + 7 * 86400000).toISOString() }), actor, nextStart);
  enterprise.issue(f.db, next.id, { revision: 1, termsDigest: next.termsDigest, commercialApproved: true }, actor, nextStart);
  await f.service.checkout(f.db, next.id, { revision: 1, termsDigest: next.termsDigest, termsAccepted: true }, { id: 1 });
  const oldSession = structuredClone(f.session());
  const nextSession = await f.client.checkout.sessions.retrieve(next.checkoutSessionId);
  Object.assign(nextSession, { status: 'complete', payment_status: 'paid', customer: 'cus_synthetic', payment_intent: structuredClone(oldSession.payment_intent) });
  nextSession.payment_intent.id = 'pi_renewal'; nextSession.payment_intent.metadata = { ...nextSession.metadata };
  nextSession.payment_intent.latest_charge.payment_intent = 'pi_renewal'; nextSession.payment_intent.latest_charge.created = nextStart / 1000;
  const originalRetrieve = f.client.checkout.sessions.retrieve;
  f.client.checkout.sessions.retrieve = async id => id === nextSession.id ? structuredClone(nextSession) : originalRetrieve(id);
  await f.process(f.event('checkout.session.completed', nextSession, 'evt_renewal'));
  assert.equal(f.db.company.enterpriseActiveQuoteId, next.id); assert.equal(enterprise.access(f.db.company, nextStart).locked, false);
  f.session().payment_intent.latest_charge.amount_refunded = f.quote.totalAmount;
  await f.process(f.event('checkout.session.completed', oldSession, 'evt_old_refund_late'));
  assert.equal(f.quote.id, oldId); assert.equal(f.quote.status, 'refunded');
  assert.equal(f.db.company.enterpriseActiveQuoteId, next.id); assert.equal(enterprise.access(f.db.company, nextStart).locked, false);
});

test('new subscription while payment is pending requires review, never silently wins billing precedence', async () => {
  const f = fixture(); f.approve(); await f.pay(); f.db.company.stripeSubscriptionId = 'sub_created_elsewhere'; f.paid(); await f.process();
  assert.equal(f.quote.status, 'payment_review'); assert.equal(f.db.company.plan,'starter'); assert.equal(enterprise.access(f.db.company, epoch),null);
});

test('an early webhook for an uncertain checkout returns a retryable error', async () => {
  const f = fixture(); f.approve(); f.failCreate(true); await assert.rejects(f.pay());
  assert.equal(f.quote.checkoutSessionId, undefined);
  await assert.rejects(f.process(), error => error.statusCode === 503);
  assert.equal(f.db.company.plan, 'starter');
});

async function paidRefundFixture(refunded = 0) {
  const f = fixture(); f.approve(); await f.pay(); f.paid(); await f.process();
  const term = { paidAt: f.quote.paidAt, startsAt: f.quote.startsAt, endsAt: f.quote.endsAt };
  f.session().payment_intent.latest_charge.amount_refunded = refunded;
  if (refunded) await f.process(f.event('refund.updated', { id: 're_synthetic', payment_intent: 'pi_synthetic', status: 'pending' }, 'evt_pending_refund'));
  f.clock(epoch + 86400000);
  return { f, term };
}
const failedRefundEvent = (f, extra = {}) => f.event('refund.failed', {
  id: 're_synthetic', charge: 'ch_synthetic', payment_intent: 'pi_synthetic', status: 'failed', ...extra
}, 'evt_failed_refund');
const assertTerm = (f, term) => assert.deepEqual({ paidAt: f.quote.paidAt, startsAt: f.quote.startsAt, endsAt: f.quote.endsAt }, term);

test('failed refund reaches the webhook reconciliation path and restores only the original verified term', async () => {
  const webhook = require('./stripe-webhook');
  for (const priorRefund of [1, input().totalAmount]) {
    for (const throughCharge of [false, true]) {
      const { f, term } = await paidRefundFixture(priorRefund);
      assert.equal(enterprise.access(f.db.company, epoch).locked, true);
      f.session().payment_intent.latest_charge.amount_refunded = 0;
      const event = failedRefundEvent(f, throughCharge ? { payment_intent: null } : {});
      const result = await webhook.processEvent(event, { processEnterprise: e => f.process(e) });
      assert.deepEqual(result, { received: true });
      assert.equal(f.quote.status, 'paid'); assert.equal(enterprise.access(f.db.company, epoch + 86400000).locked, false);
      assertTerm(f, term); assert.ok(f.quote.webhookEvents.includes(event.id));
    }
  }
});

test('stale failed-refund payload cannot clear a current refund or unresolved dispute', async () => {
  for (const state of [{ refunded: 1, status: 'payment_review' }, { refunded: input().totalAmount, status: 'refunded' },
    { disputed: true, disputeStatus: 'under_review', status: 'payment_review' }, { disputed: true, disputeStatus: 'lost', status: 'payment_review' }]) {
    const { f, term } = await paidRefundFixture(input().totalAmount);
    Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: state.refunded || 0, disputed: Boolean(state.disputed) });
    if (state.disputed) f.disputes.push({ status: state.disputeStatus });
    assert.equal(await f.process(failedRefundEvent(f, { amount: 0 })), true);
    assert.equal(f.quote.status, state.status); assert.equal(enterprise.access(f.db.company, epoch).locked, true); assertTerm(f, term);
  }
});

test('failed refund can recover with a current won or closed-warning dispute without renewing the term', async () => {
  for (const status of ['won', 'warning_closed']) {
    const { f, term } = await paidRefundFixture(input().totalAmount);
    Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: 0, disputed: true });
    f.disputes.push({ status });
    assert.equal(await f.process(failedRefundEvent(f)), true);
    assert.equal(f.quote.status, 'paid'); assert.equal(enterprise.access(f.db.company, epoch).locked, false); assertTerm(f, term);
  }
});

test('failed refund duplicates and out-of-order deliveries re-read current state and re-save after a storage retry', async () => {
  const { f, term } = await paidRefundFixture(input().totalAmount);
  const charge = f.session().payment_intent.latest_charge;
  const oldRefund = f.event('refund.updated', { payment_intent: 'pi_synthetic', status: 'pending' }, 'evt_old_refund');
  const event = failedRefundEvent(f);
  charge.amount_refunded = 0; await f.process(event);
  const before = f.saves(); f.failSave(true); await assert.rejects(f.process(event), /storage/);
  f.failSave(false); await f.process(event); assert.equal(f.saves(), before + 2);
  assert.equal(f.quote.webhookEvents.filter(id => id === event.id).length, 1);
  await f.process(oldRefund); assert.equal(f.quote.status, 'paid');
  charge.amount_refunded = f.quote.totalAmount; await f.process(event);
  assert.equal(f.quote.status, 'refunded'); assert.equal(enterprise.access(f.db.company, epoch).locked, true); assertTerm(f, term);
});

test('incomplete or malformed authoritative refund/dispute fields cannot activate, restore, or revoke access', async () => {
  const invalid = [
    c => delete c.amount_refunded, c => c.amount_refunded = null, c => c.amount_refunded = NaN,
    c => c.amount_refunded = -1, c => c.amount_refunded = input().totalAmount + 1,
    c => c.amount_refunded = Infinity, c => c.amount_refunded = 0.5,
    c => c.amount_refunded = '0', c => c.amount_refunded = false,
    c => delete c.disputed, c => c.disputed = null, c => c.disputed = 'false', c => c.disputed = 0
  ];
  for (const startingState of ['unpaid', 'paid', 'refunded', 'payment_review']) {
    for (const mutate of invalid) {
      const f = fixture(); f.approve(); await f.pay(); f.paid();
      if (startingState !== 'unpaid') {
        await f.process();
        if (startingState !== 'paid') {
          f.session().payment_intent.latest_charge.amount_refunded = startingState === 'refunded' ? f.quote.totalAmount : 1;
          await f.process();
        }
      }
      const before = structuredClone(f.db.company), saves = f.saves();
      Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: 0, disputed: false });
      mutate(f.session().payment_intent.latest_charge);
      await assert.rejects(f.process(f.event('refund.updated', { payment_intent: 'pi_synthetic' }, 'evt_incomplete_refund')), e => e.statusCode === 503);
      // An initially unseen PaymentIntent may be bound before validation; no access, dates or verification markers may change.
      if (startingState === 'unpaid') before.enterpriseQuotes[0].paymentIntentId = 'pi_synthetic';
      assert.deepEqual(f.db.company, before); assert.equal(f.saves(), saves);
    }
  }
});

test('incomplete dispute-list evidence does not clear a locked term', async () => {
  for (const result of [{ data: [{ status: 'won' }] }, { data: [{ status: 'won' }], has_more: null },
    { data: [{ status: 'won' }], has_more: 'false' }, { data: null, has_more: false }]) {
    const { f } = await paidRefundFixture(input().totalAmount);
    Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: 0, disputed: true });
    f.client.disputes.list = async () => result;
    const before = structuredClone(f.db.company), saves = f.saves();
    await assert.rejects(f.process(failedRefundEvent(f)), e => e.statusCode === 503);
    assert.deepEqual(f.db.company, before); assert.equal(f.saves(), saves);
  }
});

test('failed-refund provider failures preserve current access and retry without refund-write privileges', async () => {
  for (const priorRefund of [0, input().totalAmount]) {
    for (const resource of ['checkout', 'paymentIntents', 'charges', 'disputes']) {
      const { f } = await paidRefundFixture(priorRefund);
      Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: 0, disputed: resource === 'disputes' });
      f.disputes.push({ status: 'won' });
      const api = resource === 'checkout' ? f.client.checkout.sessions : f.client[resource];
      const method = resource === 'disputes' ? 'list' : 'retrieve', original = api[method];
      api[method] = async () => { throw new Error('Synthetic provider outage'); };
      const event = failedRefundEvent(f, resource === 'charges' ? { payment_intent: null } : {});
      const before = structuredClone(f.db.company), saves = f.saves();
      await assert.rejects(f.process(event), /provider outage/);
      assert.deepEqual(f.db.company, before); assert.equal(f.saves(), saves);
      api[method] = original; assert.equal(await f.process(event), true); assert.equal(f.quote.status, 'paid');
      assert.equal(f.client.refunds, undefined);
    }
  }
});

test('failed refund retains canonical session, tenant, digest, mode, amount, currency, customer and payment bindings', async () => {
  for (const mutate of [s => s.id = 'cs_forged', s => s.client_reference_id = OTHER,
    s => s.metadata.company_id = OTHER, s => s.metadata.terms_digest = 'forged', s => s.livemode = true,
    s => s.mode = 'subscription', s => s.amount_total--, s => s.currency = 'eur', s => s.customer = 'cus_wrong',
    s => s.payment_intent.customer = 'cus_wrong', s => s.payment_intent.id = 'pi_wrong',
    s => s.payment_intent.metadata.quote_id = OTHER, s => s.payment_intent.metadata.terms_digest = 'forged',
    s => s.payment_intent.amount_received--, s => s.payment_intent.latest_charge.paid = false,
    s => s.payment_intent.latest_charge.payment_intent = 'pi_wrong']) {
    const { f } = await paidRefundFixture(input().totalAmount);
    const originalPi = structuredClone(f.session().payment_intent);
    f.client.paymentIntents.retrieve = async () => originalPi;
    f.session().payment_intent.latest_charge.amount_refunded = 0;
    const before = structuredClone(f.db.company); mutate(f.session());
    await assert.rejects(f.process(failedRefundEvent(f))); assert.deepEqual(f.db.company, before);
  }
  const { f } = await paidRefundFixture(input().totalAmount);
  const wrongPi = structuredClone(f.session().payment_intent); wrongPi.id = 'pi_wrong';
  f.client.paymentIntents.retrieve = async () => wrongPi;
  await assert.rejects(f.process(failedRefundEvent(f, { payment_intent: 'pi_wrong' })), /saved checkout/);
  assert.equal(f.quote.status, 'refunded');
});

test('Enterprise failed-refund event is additive to the seven standard events', () => {
  const standard = require('./stripe-webhook').EVENTS;
  const extra = [...enterprise.EVENTS].filter(type => !standard.has(type));
  assert.equal(extra.length, 8); assert.ok(extra.includes('refund.failed'));
  assert.equal(new Set([...standard, ...enterprise.EVENTS]).size, 15);
});

test('malformed or unknown dispute rows preserve paid and locked states with a retryable error', async () => {
  const malformed = [{}, null, undefined, [], 1, 'won', { status: null }, { status: undefined },
    { status: '' }, { status: 'unknown_future_status' }, { status: 0 }, { status: ['won'] }];
  for (const startingState of ['paid', 'payment_review', 'refunded']) {
    for (const row of malformed) {
      const { f, term } = await paidRefundFixture(startingState === 'refunded' ? input().totalAmount : 0);
      f.session().payment_intent.latest_charge.disputed = true;
      f.disputes.push({ status: startingState === 'paid' ? 'won' : 'under_review' });
      await f.process(f.event('charge.dispute.updated', { payment_intent: 'pi_synthetic' }, 'evt_verified_dispute'));
      assert.equal(f.quote.status, startingState);
      const before = structuredClone(f.db.company), saves = f.saves();
      f.clock(epoch + 2 * 86400000);
      f.session().payment_intent.latest_charge.amount_refunded = 0;
      f.client.disputes.list = async () => ({ data: [{ status: 'won' }, row], has_more: false });
      await assert.rejects(f.process(failedRefundEvent(f)), e => e.statusCode === 503);
      assert.deepEqual(f.db.company, before); assert.equal(f.saves(), saves); assertTerm(f, term);
    }
  }
});

test('documented dispute statuses, pagination and empty lists retain the existing access policy', async () => {
  for (const status of ['warning_needs_response', 'warning_under_review', 'warning_closed',
    'needs_response', 'under_review', 'won', 'lost', 'prevented']) {
    const { f, term } = await paidRefundFixture(input().totalAmount);
    Object.assign(f.session().payment_intent.latest_charge, { amount_refunded: 0, disputed: true });
    f.disputes.push({ status }); await f.process(failedRefundEvent(f));
    assert.equal(f.quote.status, ['won', 'warning_closed'].includes(status) ? 'paid' : 'payment_review'); assertTerm(f, term);
  }
  for (const result of [{ data: [], has_more: false }, { data: [{ status: 'won' }], has_more: true }]) {
    const { f, term } = await paidRefundFixture();
    f.session().payment_intent.latest_charge.disputed = true;
    f.client.disputes.list = async () => result; await f.process(failedRefundEvent(f));
    assert.equal(f.quote.status, 'payment_review'); assertTerm(f, term);
  }
});
