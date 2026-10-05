'use strict';
const assert = require('node:assert/strict');
const enterprise = require('../enterprise-billing');
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const epoch = Date.parse('2026-10-05T12:00:00Z');
const env = { PDL_REQUIRE_AUTH: '1', PDL_ENTERPRISE_CHECKOUT_ENABLED: '1', PDL_PUBLIC_URL: 'https://pdl.example', STRIPE_SECRET_KEY: 'sk_test_synthetic_only', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_only' };
const actor = { id: 1, role: 'platform_owner' };
function input(overrides = {}) { return { requestId: 'synthetic_request_0001', totalAmount: 123400, currency: 'usd', limits: { users: 12, activeProjects: null },
  features: { timeCards: true, templates: false }, term: 'annual_upfront_manual_review', startPolicy: 'verified_payment',
  taxTreatment: 'included', expiresAt: new Date(epoch + 86400000 * 7).toISOString(), scope: 'Synthetic scope for tests only',
  cancellationPolicy: 'Synthetic cancellation terms', refundPolicy: 'Synthetic refund terms', ...overrides }; }
function fixture() {
  const db = { company: { id: COMPANY, name: 'Synthetic tenant', plan: 'starter', subscriptionStatus: 'Cancelled', features: { templates: true } }, users: [{ id: 1, role: 'owner', status: 'Active' }], projects: [] };
  let clock = epoch, saves = 0, createCalls = 0, failSave = false, failCreate = false;
  const sessions = new Map(), calls = [], disputes = [];
  const client = { checkout: { sessions: {
    create: async (params, options) => {
      createCalls++; calls.push({ params: structuredClone(params), options });
      if (!sessions.has(options.idempotencyKey)) {
        const session = { id: 'cs_synthetic_' + sessions.size, status: 'open', payment_status: 'unpaid', livemode: false,
          mode: params.mode, metadata: { ...params.metadata }, client_reference_id: params.client_reference_id,
          amount_total: params.line_items[0].price_data.unit_amount, currency: params.line_items[0].price_data.currency,
          customer: params.customer || null, url: 'https://checkout.stripe.com/c/pay/synthetic' };
        sessions.set(options.idempotencyKey, session);
      }
      if (failCreate) throw new Error('Synthetic connection failure after Stripe accepted request');
      return structuredClone(sessions.get(options.idempotencyKey));
    },
    retrieve: async id => structuredClone([...sessions.values()].find(session => session.id === id)),
    expire: async id => { const s = [...sessions.values()].find(row => row.id === id); s.status = 'expired'; return s; }
  } }, disputes: { list: async () => ({ data: disputes, has_more: false }) }, paymentIntents: { retrieve: async id => structuredClone([...sessions.values()].find(s => s.payment_intent?.id === id)?.payment_intent) },
    charges: { retrieve: async id => structuredClone([...sessions.values()].find(s => s.payment_intent?.latest_charge?.id === id)?.payment_intent.latest_charge) } };
  const persist = async () => { saves++; if (failSave) throw new Error('Synthetic durable storage failure'); };
  const service = enterprise.createService({ client, persist, env, now: () => clock });
  const quote = enterprise.createDraft(db, input(), actor, clock);
  const approve = () => enterprise.issue(db, quote.id, { revision: quote.revision, termsDigest: quote.termsDigest, commercialApproved: true }, actor, clock);
  const pay = () => service.checkout(db, quote.id, { revision: quote.revision, termsDigest: quote.termsDigest, termsAccepted: true }, { id: 1 });
  const session = () => [...sessions.values()][0];
  const paid = () => {
    Object.assign(session(), { status: 'complete', payment_status: 'paid', customer: 'cus_synthetic', payment_intent: { id: 'pi_synthetic', customer: 'cus_synthetic', status: 'succeeded',
      livemode: false, amount: quote.totalAmount, amount_received: quote.totalAmount, currency: quote.currency, metadata: { ...session().metadata },
      latest_charge: { id: 'ch_synthetic', payment_intent: 'pi_synthetic', amount: quote.totalAmount, currency: quote.currency, paid: true, livemode: false, amount_refunded: 0, disputed: false, created: Math.floor(clock / 1000) } } });
  };
  const event = (type = 'checkout.session.completed', object = session(), id = 'evt_synthetic') => ({ id, type, created: Math.floor(clock / 1000), livemode: false, data: { object: structuredClone(object) } });
  const process = (evt = event()) => service.processEvent(evt, async (id, task) => { assert.equal(id, COMPANY); return task(db); });
  return { db, quote, approve, pay, paid, session, process, event, service, client, calls, disputes,
    clock: value => clock = value, failSave: value => failSave = value, failCreate: value => failCreate = value,
    saves: () => saves, creates: () => createCalls };
}


module.exports={fixture,input,epoch,env,actor,COMPANY,OTHER};
