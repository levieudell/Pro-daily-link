'use strict';
const crypto = require('node:crypto');
const Stripe = require('stripe');

const OFFER = 'pdl-enterprise-annual-v1';
const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired', 'charge.refunded',
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.updated', 'refund.failed']);
const DISPUTE_STATUSES = new Set(['warning_needs_response', 'warning_under_review', 'warning_closed',
  'needs_response', 'under_review', 'won', 'lost', 'prevented']);
const idOf = value => typeof value === 'string' ? value : value?.id;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const iso = now => new Date(now).toISOString();
function enabled(env = process.env) { return env.PDL_ENTERPRISE_CHECKOUT_ENABLED === '1'; }
function configured(env = process.env) {
  return enabled(env) && env.PDL_REQUIRE_AUTH === '1' && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.PDL_PUBLIC_URL);
}
function quotes(company) { return Array.isArray(company.enterpriseQuotes) ? company.enterpriseQuotes : []; }
function getQuote(company, id) {
  const quote = quotes(company).find(row => row.id === id && row.companyId === String(company.id));
  if (!quote) throw fail('Enterprise quote not found.', 404);
  return quote;
}
function currentQuote(company) {
  return quotes(company).find(row => row.id === company.enterpriseActiveQuoteId && row.companyId === String(company.id));
}
function access(company, now = Date.now()) {
  if (company.plan !== 'enterprise' && !company.enterpriseActiveQuoteId) return null;
  const quote = currentQuote(company);
  if (!quote) return { status: 'Incomplete', locked: true, reason: 'Enterprise payment has not been verified.' };
  if (quote.status !== 'paid') return { status: quote.status === 'refunded' ? 'Refunded' : 'Payment review', locked: true,
    reason: 'This Enterprise payment needs review. Contact Pro Daily Link support.' };
  if (!(Date.parse(quote.startsAt) <= now && Date.parse(quote.endsAt) > now)) {
    return { status: 'Review due', locked: true, reason: 'Your annual Enterprise term has ended. Contact Pro Daily Link for your yearly review.' };
  }
  return { status: 'Active', locked: false, reason: '' };
}
function plan(company) {
  if (company.plan !== 'enterprise') return null;
  const quote = currentQuote(company);
  return { name: 'Enterprise', price: null, annualPrice: quote ? quote.totalAmount / 100 : null,
    maxUsers: quote ? quote.limits.users : 0, maxProjects: quote ? quote.limits.activeProjects : 0 };
}
function annualEnd(start) {
  const date = new Date(start), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCFullYear(date.getUTCFullYear() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
function requiredText(input, key, max) {
  if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) throw fail(`Provide ${key} (up to ${max} characters).`);
  return input[key].trim();
}
function normalize(input, now) {
  if (!Number.isSafeInteger(input.totalAmount) || input.totalAmount < 50 || input.totalAmount > 99999999) throw fail('Enter an annual total in minor currency units, from 50 to 99999999.');
  const currency = String(input.currency || '').toLowerCase();
  if (!['usd', 'cad', 'eur', 'gbp', 'aud'].includes(currency)) throw fail('Choose a supported two-decimal currency.');
  const limits = {};
  for (const key of ['users', 'activeProjects']) {
    const value = input.limits?.[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 1000000)) throw fail(`Choose an explicit ${key} limit, or unlimited.`);
    limits[key] = value;
  }
  if (typeof input.features?.timeCards !== 'boolean' || typeof input.features?.templates !== 'boolean') throw fail('Choose the included features explicitly.');
  if (input.term !== 'annual_upfront_manual_review' || input.startPolicy !== 'verified_payment') throw fail('Confirm annual upfront payment, a term beginning at verified payment, and manual yearly review with no automatic renewal.');
  if (!['included', 'not_applicable'].includes(input.taxTreatment)) throw fail('Confirm that the total includes any applicable tax, or tax is not applicable.');
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires < now + 31 * 60000 || expires > now + 90 * 86400000) throw fail('Quote expiry must be between 31 minutes and 90 days away.');
  return { totalAmount: input.totalAmount, currency, limits, features: { timeCards: input.features.timeCards, templates: input.features.templates },
    term: input.term, startPolicy: input.startPolicy, taxTreatment: input.taxTreatment, expiresAt: iso(expires),
    scope: requiredText(input, 'scope', 2000), cancellationPolicy: requiredText(input, 'cancellationPolicy', 2000),
    refundPolicy: requiredText(input, 'refundPolicy', 2000) };
}
function digest(quote) {
  return crypto.createHash('sha256').update(JSON.stringify([quote.companyId, quote.totalAmount, quote.currency,
    quote.limits, quote.features, quote.term, quote.startPolicy, quote.taxTreatment, quote.expiresAt,
    quote.scope, quote.cancellationPolicy, quote.refundPolicy])).digest('hex');
}
function publicQuote(quote) {
  const { id, companyId, companyName, revision, status, totalAmount, currency, limits, features, term,
    startPolicy, taxTreatment, expiresAt, scope, cancellationPolicy, refundPolicy, termsDigest, createdAt,
    issuedAt, paidAt, startsAt, endsAt, cancelledAt, reviewReason } = quote;
  return { id, companyId, companyName, revision, status, totalAmount, currency, limits, features, term,
    startPolicy, taxTreatment, expiresAt, scope, cancellationPolicy, refundPolicy, termsDigest, createdAt,
    issuedAt, paidAt, startsAt, endsAt, cancelledAt, reviewReason };
}
function list(company, owner = false) { return quotes(company).filter(q => !owner || q.status !== 'draft').map(publicQuote); }
function usageFits(db, quote) {
  const users = (db.users || []).filter(row => row.status === 'Active').length;
  const projects = (db.projects || []).filter(row => !row.archived).length;
  if (quote.limits.users !== null && quote.limits.users < users || quote.limits.activeProjects !== null && quote.limits.activeProjects < projects) {
    throw fail('Quote limits are below current company usage. Update the draft or reduce usage before continuing.', 409);
  }
}
function eligible(company, now) {
  if (company.demo || company.id === 'northstar' || company.billingExempt || company.founder?.requested || company.stripeSubscriptionId || company.pendingCheckout) {
    throw fail('This company requires a reviewed billing migration before an Enterprise quote can be issued.', 409);
  }
  const current = currentQuote(company);
  if (current && (current.status !== 'paid' || Date.parse(current.endsAt) > now)) {
    throw fail('Complete the current Enterprise term and any payment review before starting a new annual term.', 409);
  }
}
function assertRevision(quote, input) {
  if (input.revision !== quote.revision) throw fail('This quote changed. Refresh before continuing.', 409);
}
function audit(quote, action, actor, now) {
  quote.audit ||= []; quote.audit.push({ action, actorId: String(actor.id), at: iso(now), revision: quote.revision });
}
function createDraft(db, input, actor, now = Date.now()) {
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw fail('A unique draft request ID is required.');
  const previous = quotes(db.company).find(q => q.requestId === input.requestId);
  const terms = normalize(input, now);
  if (previous) {
    if (digest({ ...terms, companyId: String(db.company.id) }) !== previous.termsDigest) throw fail('This request ID was already used for different terms.', 409);
    return previous;
  }
  const quote = { id: crypto.randomUUID(), companyId: String(db.company.id), companyName: String(db.company.name),
    requestId: input.requestId, revision: 1, status: 'draft', ...terms, createdAt: iso(now), createdBy: String(actor.id) };
  quote.termsDigest = digest(quote); audit(quote, 'draft_created', actor, now);
  db.company.enterpriseQuotes = [...quotes(db.company), quote];
  return quote;
}
function editDraft(db, id, input, actor, now = Date.now()) {
  const quote = getQuote(db.company, id); assertRevision(quote, input);
  if (quote.status !== 'draft') throw fail('Only an unissued draft can be edited. Cancel it and create a replacement.', 409);
  Object.assign(quote, normalize(input, now), { revision: quote.revision + 1 });
  quote.termsDigest = digest(quote); audit(quote, 'draft_updated', actor, now); return quote;
}
function issue(db, id, input, actor, now = Date.now()) {
  const quote = getQuote(db.company, id); assertRevision(quote, input);
  if (quote.status === 'offered' && input.termsDigest === quote.termsDigest) return quote;
  if (quote.status !== 'draft') throw fail('Only a draft can be issued.', 409);
  if (input.commercialApproved !== true || input.termsDigest !== quote.termsDigest) throw fail('Review and explicitly approve this exact quote before issuing it.');
  normalize(quote, now); eligible(db.company, now); usageFits(db, quote);
  if(quotes(db.company).some(q=>q.id!==quote.id&&['offered','checkout_pending','processing'].includes(q.status)))throw fail('Cancel the other open Enterprise quote before issuing a replacement.',409);
  quote.status = 'offered'; quote.issuedAt = iso(now); audit(quote, 'quote_issued', actor, now); return quote;
}
function safeCheckoutUrl(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === 'checkout.stripe.com') return url.href; } catch {}
  throw fail('Stripe returned an invalid checkout URL.', 502);
}
function createService({ client, persist, env = process.env, now = () => Date.now() }) {
  let cachedClient;
  const stripe = () => client || (cachedClient ||= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 2 }));
  async function checkout(db, id, input, actor) {
    if (!configured(env)) throw fail('Enterprise checkout is not enabled. Contact Pro Daily Link support.', 503);
    const quote = getQuote(db.company, id);
    assertRevision(quote, input);
    if (!['offered', 'checkout_pending'].includes(quote.status)) throw fail('This quote is not available for payment.', 409);
    if (Date.parse(quote.expiresAt) <= now()) throw fail('This quote has expired. Request a new quote.', 409);
    if (input.termsAccepted !== true || input.termsDigest !== quote.termsDigest) throw fail('Accept this exact Enterprise quote before continuing.');
    eligible(db.company, now()); usageFits(db, quote);
    if (quote.checkoutSessionId) {
      const session = await stripe().checkout.sessions.retrieve(quote.checkoutSessionId);
      validateSession(db.company, quote, session, env);
      if (session.status === 'open') { await persist(db); return { url: safeCheckoutUrl(session.url) }; }
      throw fail(session.status === 'complete' ? 'Payment is being verified. Refresh billing in a moment.' : 'This checkout expired. Request a replacement quote.', 409);
    }
    if (!quote.checkoutParams) {
      const publicUrl = new URL(env.PDL_PUBLIC_URL);
      if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) throw fail('A secure billing return URL is required.', 503);
      const metadata = { offer: OFFER, company_id: String(db.company.id), quote_id: quote.id, terms_digest: quote.termsDigest };
      const expiry = Math.min(Math.floor(Date.parse(quote.expiresAt) / 1000), Math.floor(now() / 1000) + 23 * 3600);
      if (expiry < now() / 1000 + 1800) throw fail('This quote is too close to expiry. Request a new quote.', 409);
      quote.checkoutParams = { mode: 'payment', client_reference_id: String(db.company.id), metadata,
        integration_identifier: 'pdl-enterprise-' + Array.from(crypto.randomBytes(8), n => String.fromCharCode(97 + n % 26)).join(''),
        line_items: [{ price_data: { currency: quote.currency, unit_amount: quote.totalAmount,
          product_data: { name: 'Pro Daily Link Enterprise — annual term', description: 'Annual upfront payment. Manual yearly review. No automatic renewal.' } }, quantity: 1 }],
        payment_intent_data: { metadata }, expires_at: expiry,
        success_url: publicUrl.origin + '/app?tenant=' + encodeURIComponent(db.company.id) + '&billing=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: publicUrl.origin + '/app?tenant=' + encodeURIComponent(db.company.id) + '&billing=cancelled',
        custom_text: { submit: { message: 'One annual term, paid upfront. Starts when payment is verified. No automatic renewal. Your accepted quote controls scope, cancellation and refunds.' } } };
      if (db.company.stripeCustomerId) quote.checkoutParams.customer = db.company.stripeCustomerId;
      else quote.checkoutParams.customer_creation = 'always';
      quote.expectedCustomerId = db.company.stripeCustomerId || null;
      quote.checkoutAttemptAt = iso(now());
      quote.status = 'checkout_pending'; quote.acceptedAt = iso(now()); quote.acceptedBy = String(actor.id);
      audit(quote, 'terms_accepted', actor, now());
      // Commit the immutable request before contacting Stripe. Retries use identical parameters/key.
    }
    if(now()-Date.parse(quote.checkoutAttemptAt)>=23*3600000)throw fail('An earlier checkout result needs review. Do not start another payment; contact support.',409);
    await persist(db);
    const session = await stripe().checkout.sessions.create(quote.checkoutParams, { idempotencyKey: 'enterprise-' + quote.id + '-v' + quote.revision });
    quote.checkoutSessionId = session.id;
    validateSession(db.company, quote, session, env);
    const result = { url: safeCheckoutUrl(session.url) };
    await persist(db); return result;
  }
  async function cancel(db, id, input, actor) {
    const quote = getQuote(db.company, id); assertRevision(quote, input);
    if (quote.status === 'cancelled') { await persist(db); return quote; }
    if (!['draft', 'offered', 'checkout_pending', 'expired', 'payment_failed'].includes(quote.status)) throw fail('Paid or processing payments require a separate billing review. No refund has been made.', 409);
    if (quote.checkoutParams && !quote.checkoutSessionId) {
      // Recover an uncertain creation with the original idempotency key before cancelling.
      if(now()-Date.parse(quote.checkoutAttemptAt)>=23*3600000)throw fail('The earlier checkout needs manual payment review before cancellation.',409);
      await persist(db);
      const session = await stripe().checkout.sessions.create(quote.checkoutParams, { idempotencyKey: 'enterprise-' + quote.id + '-v' + quote.revision });
      quote.checkoutSessionId = session.id; await persist(db);
    }
    if (quote.checkoutSessionId) {
      const session = await stripe().checkout.sessions.retrieve(quote.checkoutSessionId);
      validateSession(db.company, quote, session, env);
      if (session.status === 'complete') throw fail('Payment is complete or processing. Review billing before cancellation; no refund has been made.', 409);
      if (session.status === 'open') await stripe().checkout.sessions.expire(session.id, {}, { idempotencyKey: 'enterprise-cancel-' + quote.id });
    }
    quote.status = 'cancelled'; quote.cancelledAt = iso(now()); audit(quote, 'quote_cancelled', actor, now()); await persist(db); return quote;
  }
  async function reconcile(db, quote, event, expectedPaymentIntentId) {
    if (!quote.checkoutSessionId) throw fail('Enterprise checkout has not finished saving. Retry this event.', 503);
    const session = await stripe().checkout.sessions.retrieve(quote.checkoutSessionId, { expand: ['payment_intent.latest_charge'] });
    validateSession(db.company, quote, session, env);
    const pi = session.payment_intent;
    if(expectedPaymentIntentId&&idOf(pi)!==expectedPaymentIntentId)throw fail('Enterprise event payment does not match the saved checkout.',400);
    if (pi && typeof pi !== 'object') throw fail('Enterprise payment details are unavailable.', 503);
    if (pi && (pi.metadata?.offer !== OFFER || pi.metadata?.quote_id !== quote.id || pi.metadata?.company_id !== String(db.company.id) || pi.metadata?.terms_digest !== quote.termsDigest || pi.currency !== quote.currency || pi.amount !== quote.totalAmount || pi.livemode !== session.livemode || quote.paymentIntentId && quote.paymentIntentId !== pi.id)) throw fail('Enterprise payment does not match the saved quote.', 400);
    const charge = pi?.latest_charge;
    if (pi) quote.paymentIntentId = pi.id;
    if (session.status === 'expired' && !quote.paidAt && quote.status !== 'cancelled') quote.status = 'expired';
    else if (session.status === 'complete' && session.payment_status !== 'paid' && !quote.paidAt && quote.status !== 'cancelled') quote.status = event.type === 'checkout.session.async_payment_failed' ? 'payment_failed' : 'processing';
    if (session.status === 'complete' && session.payment_status === 'paid') {
      if (!idOf(session.customer) || idOf(pi?.customer)!==idOf(session.customer) || !pi || pi.status !== 'succeeded' || pi.amount_received !== quote.totalAmount || !charge || typeof charge !== 'object' || charge.payment_intent !== pi.id || charge.amount !== quote.totalAmount || charge.currency !== quote.currency || charge.paid !== true || charge.livemode !== session.livemode || !Number.isFinite(charge.created)) throw fail('Waiting for verified Enterprise payment details.', 503);
      const refunded = charge.amount_refunded;
      // Missing or malformed provider evidence is not a verified zero refund/no dispute.
      if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > quote.totalAmount || typeof charge.disputed !== 'boolean') throw fail('Waiting for verified Enterprise refund and dispute details.', 503);
      let disputed = charge.disputed === true;
      if (disputed) {
        const disputes = await stripe().disputes.list({ charge: charge.id, limit: 100 });
        if (!disputes || !Array.isArray(disputes.data) || typeof disputes.has_more !== 'boolean') throw fail('Waiting for verified Enterprise dispute details.', 503);
        if (disputes.data.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !DISPUTE_STATUSES.has(row.status))) throw fail('Waiting for verified Enterprise dispute details.', 503);
        disputed = disputes.has_more || !disputes.data?.length || disputes.data.some(row => row.status !== 'won' && row.status !== 'warning_closed');
      }
      quote.paidAt ||= iso(now()); quote.startsAt ||= quote.paidAt; quote.endsAt ||= annualEnd(quote.startsAt);
      quote.status = refunded >= quote.totalAmount ? 'refunded' : refunded > 0 || disputed || quote.cancelledAt ? 'payment_review' : 'paid';
      const commercialConflict=Boolean(db.company.stripeSubscriptionId||db.company.founder?.requested||db.company.billingExempt);
      if(commercialConflict){quote.status='payment_review';}
      quote.reviewReason = db.company.stripeSubscriptionId||db.company.founder?.requested||db.company.billingExempt ? 'Company billing changed while payment was pending' : refunded > 0 ? 'Refund recorded' : disputed ? 'Dispute requires review' : quote.cancelledAt ? 'Payment received after quote cancellation' : null;
      const active = currentQuote(db.company);
      if (!commercialConflict && (!active || active.id === quote.id || Date.parse(active.endsAt) <= Date.parse(quote.startsAt))) {
        db.company.enterpriseActiveQuoteId = quote.id;
        db.company.plan = 'enterprise'; db.company.billingCycle = 'annual'; db.company.planPrice = quote.totalAmount / 100;
        db.company.subscriptionStatus = access(db.company, now()).status;
        db.company.nextBillingAt = null;
        if (idOf(session.customer)) db.company.stripeCustomerId = idOf(session.customer);
        if (quote.status === 'paid') db.company.features = { ...db.company.features, ...quote.features };
      } else if (active && active.id !== quote.id && Date.parse(quote.endsAt) > Date.parse(active.startsAt)) { quote.status = 'payment_review'; quote.reviewReason = 'Overlapping annual payment requires review'; }
    }
    quote.webhookEvents = [...new Set([...(quote.webhookEvents || []), event.id])].slice(-200);
    quote.lastVerifiedAt = iso(now());
    // Persist again on duplicate deliveries, including a retry after cloud persistence failed.
    await persist(db);
  }
  async function processEvent(event, withCompany) {
    if (!EVENTS.has(event.type)) return false;
    let object = event.data.object;
    if (event.type.startsWith('checkout.session.')) {
      // The webhook is already signature-verified. Metadata routes a lookup; it never grants access.
      if (object.metadata?.offer !== OFFER) return false;
    } else {
      let paymentIntentId = idOf(object.payment_intent);
      if (!paymentIntentId && idOf(object.charge)) {
        const charge = await stripe().charges.retrieve(idOf(object.charge)); paymentIntentId = idOf(charge.payment_intent);
      }
      if (!paymentIntentId) return false;
      object = await stripe().paymentIntents.retrieve(paymentIntentId);
      if (object.metadata?.offer !== OFFER) return false;
    }
    const companyId = String(object.metadata?.company_id || ''), quoteId = String(object.metadata?.quote_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(companyId) || !/^[0-9a-f-]{36}$/i.test(quoteId)) throw fail('Invalid Enterprise payment mapping.', 400);
    await withCompany(companyId, async db => {
      const quote = getQuote(db.company, quoteId);
      if(!quote.checkoutSessionId)throw fail('Enterprise checkout has not finished saving. Retry this event.',503);
      if (event.type.startsWith('checkout.session.') ? object.id !== quote.checkoutSessionId : quote.paymentIntentId && object.id !== quote.paymentIntentId) throw fail('Enterprise event does not match the saved checkout.', 400);
      if (!quote.issuedAt || !quote.acceptedAt) throw fail('Enterprise quote has not been issued and accepted.', 400);
      await reconcile(db, quote, event, event.type.startsWith('checkout.session.')?null:object.id);
    });
    return true;
  }
  return { checkout, cancel, processEvent, reconcile };
}
function validateSession(company, quote, session, env) {
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
  if (session.id !== quote.checkoutSessionId || session.mode !== 'payment' || session.livemode !== live ||
      session.client_reference_id !== String(company.id) || session.metadata?.offer !== OFFER || session.metadata?.company_id !== String(company.id) ||
      session.metadata?.quote_id !== quote.id || session.metadata?.terms_digest !== quote.termsDigest || session.amount_total !== quote.totalAmount || session.currency !== quote.currency ||
      quote.expectedCustomerId && idOf(session.customer) !== quote.expectedCustomerId || company.stripeCustomerId && idOf(session.customer) && idOf(session.customer) !== company.stripeCustomerId) throw fail('Enterprise checkout does not match the saved company quote.', 400);
}
module.exports = { OFFER, EVENTS, fail, enabled, configured, quotes, getQuote, currentQuote, access, plan, annualEnd,
  digest, publicQuote, list, createDraft, editDraft, issue, createService, validateSession };
