'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseFragment } = require('parse5');
const source = fs.readFileSync('app.js', 'utf8');
const render = source.slice(source.indexOf('function renderBilling(){'), source.indexOf('async function loadBilling(){'));
assert.ok(render.startsWith('function renderBilling(){'));
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const nodes = new Map();
const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', hidden: false }); return nodes.get(selector); };
const context = vm.createContext({ billing: null, billingCycle: 'monthly', helpEscape: escape,
  $: node, $$: () => [], startCheckout: () => {} });
vm.runInContext(render, context);
const base = { plan: 'starter', planName: 'Starter', status: 'Cancelled', billingCycle: 'monthly', hasSubscription: true,
  configured: true, usage: { users: 1, activeProjects: 0 }, limits: { users: 10, activeProjects: 5 },
  plans: [{ id: 'starter', name: 'Starter', price: 99, annualPrice: 990, maxUsers: 10, maxProjects: 5, available: true, annualAvailable: true }] };
function button(values = {}) {
  context.billing = { ...base, ...values }; context.renderBilling();
  const tree = parseFragment(node('#billing-plans').innerHTML);
  function find(value) { if (value.tagName === 'button') return value; for (const child of value.childNodes || []) { const match = find(child); if (match) return match; } }
  const found = find(tree); assert.ok(found);
  return { disabled: found.attrs.some(attribute => attribute.name === 'disabled'), label: found.childNodes.map(value => value.value || '').join('') };
}
for (const status of ['Active', 'Cancelled', 'Past due', 'Incomplete', 'Trial']) {
  assert.deepEqual(button({ status }), { disabled: true, label: 'Current plan' }, 'local status alone cannot enable checkout');
}
for (const flag of [false, undefined, null, 'true', 1]) assert.equal(button({ canRestartSubscription: flag }).disabled, true);
assert.deepEqual(button({ canRestartSubscription: true }), { disabled: false, label: 'Restart plan' });
assert.deepEqual(button({ status: 'Incomplete', canResumeCheckout: true, resumePlan: 'starter', resumeBillingCycle: 'monthly' }), { disabled: false, label: 'Resume checkout' });
assert.equal(button({ canResumeCheckout: true, resumePlan: 'growth', resumeBillingCycle: 'monthly' }).disabled, true, 'resume is tied to exact pending plan');
assert.equal(button({ canResumeCheckout: true, resumePlan: 'starter', resumeBillingCycle: 'annual' }).disabled, true, 'resume is tied to exact pending cycle');
assert.deepEqual(button({ founder: { plan: 'starter' }, canRestartSubscription: true, canResumeCheckout: true }), { disabled: true, label: 'Current plan' });
assert.deepEqual(button({ hasSubscription: false, canRestartSubscription: true }), { disabled: false, label: 'Choose plan' }, 'first signup remains unchanged');
button({ canRestartSubscription: true });
assert.deepEqual(button({ canRestartSubscription: false }), { disabled: true, label: 'Current plan' }, 'a failed refreshed verification removes restart availability');
assert.deepEqual(button({ status: 'Active', canResumeCheckout: false }), { disabled: true, label: 'Current plan' }, 'completed retry no longer invites another payment');
button({ planName: '<img src=x onerror=alert(1)>', plans: [{ ...base.plans[0], name: '<script>unsafe</script>' }], canRestartSubscription: true });
assert.equal(node('#billing-summary').innerHTML.includes('<img'), false);
assert.equal(node('#billing-plans').innerHTML.includes('<script>'), false);
console.log('Standard billing UI matrix passed: fresh strict backend capabilities only, cancelled-label denial, founder guard, restart/resume labels, verification withdrawal and escaping. Real-browser visual QA remains open.');
