(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = quote => new Intl.NumberFormat(undefined, { style: 'currency', currency: quote.currency, currencyDisplay: 'code' }).format(quote.totalAmount / 100);
  const date = value => value ? new Date(value).toLocaleString() : 'Not set';
  const statuses = { draft: 'Private draft', offered: 'Available for review', checkout_pending: 'Checkout started', processing: 'Payment processing', payment_failed: 'Payment failed', paid: 'Paid', refunded: 'Refunded', payment_review: 'Payment review required', expired: 'Expired', cancelled: 'Cancelled' };
  function quoteHtml(q, { platform = false, enabled = false, review = false } = {}) {
    const expired = Date.parse(q.expiresAt) <= Date.now(), payable = ['offered', 'checkout_pending'].includes(q.status) && !expired;
    return `<article class="quote"><h3>${escape(q.companyName)} · ${escape(money(q))} upfront</h3><span class="status">${escape(statuses[q.status] || q.status)}</span><p class="muted">Quote ${escape(q.id)} · revision ${escape(q.revision)}</p>
      <div class="terms"><p><strong>Annual term</strong>Starts at verified payment. Reviewed yearly. No automatic renewal.</p><p><strong>Limits</strong>${q.limits.users === null ? 'Unlimited' : escape(q.limits.users)} active users; ${q.limits.activeProjects === null ? 'unlimited' : escape(q.limits.activeProjects)} active projects</p><p><strong>Included features</strong>Time cards: ${q.features.timeCards ? 'included' : 'not included'}<br>Forms &amp; safety templates: ${q.features.templates ? 'included' : 'not included'}</p><p><strong>Tax</strong>${q.taxTreatment === 'included' ? 'Any applicable tax is included in the total.' : 'Tax is not applicable.'}</p></div>
      <p><strong>Scope &amp; included service</strong><br>${escape(q.scope)}</p><p><strong>Cancellation policy</strong><br>${escape(q.cancellationPolicy)}</p><p><strong>Refund policy</strong><br>${escape(q.refundPolicy)}</p><p class="muted">Quote expires: ${escape(date(q.expiresAt))}${q.startsAt ? `<br>Service term: ${escape(date(q.startsAt))} through ${escape(date(q.endsAt))}` : ''}${q.reviewReason ? `<br>${escape(q.reviewReason)}` : ''}</p>
      ${review ? '' : `<div class="actions">${platform && q.status === 'draft' ? `<button type="button" class="secondary" data-action="edit" data-id="${escape(q.id)}">Edit draft</button><button type="button" data-action="issue" data-id="${escape(q.id)}">Review &amp; issue quote</button>` : ''}${platform && ['draft', 'offered', 'checkout_pending', 'expired', 'payment_failed'].includes(q.status) ? `<button type="button" class="secondary" data-action="cancel" data-id="${escape(q.id)}">Cancel quote</button>` : ''}${!platform && payable ? `<button type="button" data-action="checkout" data-id="${escape(q.id)}" ${enabled ? '' : 'disabled'}>${enabled ? 'Review & pay annual total' : 'Checkout awaiting setup'}</button>` : ''}</div>`}</article>`;
  }
  function parseAmount(value) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter an amount with no more than two decimal places.');
    const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { quoteHtml, parseAmount, escape }; return; }
  const $ = selector => document.querySelector(selector), platform = new URLSearchParams(location.search).get('platform') === '1';
  let companyId = '', state = null, sequence = 0, requestId = crypto.randomUUID(), pending = false, selected = null, editing = null;
  const companyCookie = () => document.cookie.split(';').map(row => row.trim()).find(row => row.startsWith('pdl_company='))?.slice(12) || '';
  const prefix = () => platform ? `/api/platform/companies/${encodeURIComponent(companyId)}/enterprise-quotes` : '/api/billing/enterprise-quotes';
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'include', cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(!platform && companyCookie() ? { 'X-PDL-Company': decodeURIComponent(companyCookie()) } : {}) } });
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? `Please sign in to ${platform ? 'the platform console' : 'your company account'} first.` : result.error || 'Request failed.');
    return result;
  }
  async function load() {
    const ticket = ++sequence; $('#message').textContent = '';
    if (platform && !companyId) { state = null; $('#quotes').textContent = 'Choose a company to review its quotes.'; return; }
    const result = await api(prefix());
    if (ticket !== sequence) return;
    state = result; $('#company-name').textContent = result.companyName; $('#quotes').innerHTML = result.quotes.length ? result.quotes.slice().reverse().map(q => quoteHtml(q, { platform, enabled: result.checkoutEnabled })).join('') : '<p>No Enterprise quotes yet.</p>';
    if (!result.checkoutEnabled) $('#message').textContent = 'Enterprise checkout is awaiting setup. Private drafts can be prepared, but payments cannot begin.';
  }
  function showError(error) { $('#message').textContent = error.message; }
  $('#refresh').onclick = () => load().catch(showError);
  $('#company-select').onchange = () => { if (pending) return; companyId = $('#company-select').value; editing=null; $('#quote-form').querySelector('button[type="submit"]').textContent='Save private draft'; $('#quote-form').reset(); $('#quote-form').elements.users.disabled=false; $('#quote-form').elements.projects.disabled=false; requestId = crypto.randomUUID(); load().catch(showError); };
  for (const [toggle, field] of [['unlimitedUsers', 'users'], ['unlimitedProjects', 'projects']]) {
    const form = $('#quote-form'); form.elements[toggle].onchange = () => { form.elements[field].disabled = form.elements[toggle].checked; };
  }
  $('#quote-form').onsubmit = async event => {
    event.preventDefault(); if (pending) return;
    if (!companyId) return showError(new Error('Choose a company first.'));
    const form = event.currentTarget, value = name => form.elements[name].value;
    try {
      const input = { requestId, totalAmount: parseAmount(value('amount')), currency: value('currency'),
        limits: { users: form.elements.unlimitedUsers.checked ? null : Number(value('users')), activeProjects: form.elements.unlimitedProjects.checked ? null : Number(value('projects')) },
        features: { timeCards: value('timeCards') === 'true', templates: value('templates') === 'true' }, term: 'annual_upfront_manual_review', startPolicy: 'verified_payment',
        taxTreatment: value('taxTreatment'), expiresAt: new Date(value('expiresAt')).toISOString(), scope: value('scope'), cancellationPolicy: value('cancellationPolicy'), refundPolicy: value('refundPolicy') };
      pending = true; form.querySelector('button[type="submit"]').disabled = true; $('#company-select').disabled = true;
      await api(prefix()+(editing?'/'+encodeURIComponent(editing.id):''), { method: editing?'PATCH':'POST', body: JSON.stringify({...input,...(editing?{revision:editing.revision}:{})}) }); form.reset(); editing=null; form.querySelector('button[type="submit"]').textContent='Save private draft'; requestId = crypto.randomUUID();
      form.elements.users.disabled = false; form.elements.projects.disabled = false; $('#draft-details').open = false;
      await load(); $('#message').textContent = 'Private draft saved. Review it before issuing it to the company owner.';
    } catch (error) { showError(error); } finally { pending = false; form.querySelector('button[type="submit"]').disabled = false; $('#company-select').disabled = false; }
  };
  $('#quotes').onclick = event => {
    const button = event.target.closest('[data-action]'); if (!button || pending || !state) return;
    const quote = state.quotes.find(q => q.id === button.dataset.id); if (!quote) return;
    if(button.dataset.action==='edit'){
      const form=$('#quote-form'); editing={id:quote.id,revision:quote.revision};
      const values={amount:(quote.totalAmount/100).toFixed(2),currency:quote.currency,users:quote.limits.users??'',projects:quote.limits.activeProjects??'',timeCards:String(quote.features.timeCards),templates:String(quote.features.templates),taxTreatment:quote.taxTreatment,scope:quote.scope,cancellationPolicy:quote.cancellationPolicy,refundPolicy:quote.refundPolicy};
      for(const [key,value] of Object.entries(values))form.elements[key].value=value;
      const expiry=new Date(quote.expiresAt);form.elements.expiresAt.value=new Date(expiry.getTime()-expiry.getTimezoneOffset()*60000).toISOString().slice(0,16);
      form.elements.unlimitedUsers.checked=quote.limits.users===null;form.elements.users.disabled=quote.limits.users===null;
      form.elements.unlimitedProjects.checked=quote.limits.activeProjects===null;form.elements.projects.disabled=quote.limits.activeProjects===null;
      form.elements.annual.checked=false;form.querySelector('button[type="submit"]').textContent='Save draft changes';$('#draft-details').open=true;form.elements.amount.focus();return;
    }
    selected = { quote, action: button.dataset.action, path: prefix() }; $('#review-title').textContent = selected.action === 'issue' ? 'Approve and issue this quote' : selected.action === 'cancel' ? 'Cancel this quote' : 'Review your annual payment';
    $('#review-content').innerHTML = quoteHtml(quote, { review: true }); $('#review-accepted').checked = false; $('#review-submit').disabled = true; $('#review-error').textContent = '';
    $('#review-accept-label').textContent = selected.action === 'issue' ? 'I approve this exact amount, company, limits, scope and policies, and want to make this quote visible to its owner.' : selected.action === 'cancel' ? 'Cancel this unpaid quote and expire its checkout if possible. This does not issue a refund.' : 'I accept this quote, including its annual upfront total, scope, cancellation and refund policies. Continue to Stripe to pay.';
    $('#review-submit').textContent = selected.action === 'issue' ? 'Issue quote to company owner' : selected.action === 'cancel' ? 'Cancel quote' : `Continue to Stripe · ${money(quote)}`;
    $('#review-dialog').showModal();
  };
  $('#review-accepted').onchange = () => { $('#review-submit').disabled = pending || !$('#review-accepted').checked; };
  $('#review-dialog').addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  $('#review-dialog').addEventListener('close', () => { selected = null; });
  $('#review-submit').onclick = async () => {
    if (pending || !selected || !$('#review-accepted').checked) return;
    const current = selected;
    pending = true; $('#review-submit').disabled = true; $('#company-select').disabled = true;
    $('#review-dialog').querySelectorAll('button[value="cancel"]').forEach(button => button.disabled = true);
    try {
      const input = { revision: current.quote.revision, termsDigest: current.quote.termsDigest, ...(current.action === 'issue' ? { commercialApproved: true } : current.action === 'checkout' ? { termsAccepted: true } : {}) };
      const result = await api(`${current.path}/${encodeURIComponent(current.quote.id)}/${current.action}`, { method: 'POST', body: JSON.stringify(input) });
      if (current.action === 'checkout') { const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Invalid checkout destination.'); location.assign(url.href); return; }
      $('#review-dialog').close(); await load();
    } catch (error) { $('#review-error').textContent = error.message; }
    finally { pending = false; $('#company-select').disabled = false; $('#review-submit').disabled = !$('#review-accepted').checked; $('#review-dialog').querySelectorAll('button[value="cancel"]').forEach(button => button.disabled = false); }
  };
  async function start() {
    if (platform) {
      $('#back-link').href = '/platform.html'; $('#back-link').textContent = '← Back to platform';
      const user = await api('/api/platform/auth/me'); if (user.role !== 'platform_owner') throw new Error('Only the Platform Owner can manage Enterprise quotes.');
      const overview = await api('/api/platform/overview'); $('#company-select').innerHTML += overview.companies.map(c => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
      $('#platform-tools').hidden = false;
    }
    await load();
  }
  start().catch(showError);
})(typeof window === 'undefined' ? globalThis : window);
