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
