'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const parse5 = require('parse5');
const { availableCompanyTabs } = require('./company-settings-tabs');
const { CAPABILITIES, policy } = require('./company-role-policy');
const nodes = new Map(), calls = [], pending = [], listeners = {};
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false, value: '', attributes: {}, handlers: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(type, fn) { this.handlers[type] = fn; } });
  return nodes.get(selector);
}
const selections = CAPABILITIES.map(cap => ({ dataset: { roleCap: cap.key }, value: 'follow' }));
const caps = policy({}).projectManager;
const loaded = { valid: true, revision: 0, projectManager: caps, canEdit: true, capabilities: CAPABILITIES, history: [] };
const context = { currentUser: { id: 1, role: 'owner' }, currentRole: 'office', companyId: 'A', signedInCompanyId() { return context.companyId; }, $: node, $$() { return selections; },
  escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); },
  api(url, options) { calls.push({ url, input: options?.body ? JSON.parse(options.body) : undefined }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  renderEverything() {}, loadRole() { context.reloads = (context.reloads || 0) + 1; }, window: { addEventListener(type, fn) { listeners[type] = fn; } }
};
vm.createContext(context); vm.runInContext(fs.readFileSync('company-role-restrictions-ui.js', 'utf8'), context);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const resolve = async value => { pending.shift().resolve(value); await flush(); };
const submit = () => node('#role-restrictions-form').handlers.submit({ preventDefault() {} });
const preview = { revision: 0, projectManager: { ...caps, scheduleCrews: false }, reason: '<script>synthetic</script>', previewToken: 'a'.repeat(64), expiresAt: Date.now() + 1000,
  users: [{ name: '<img src=x onerror=alert(1)>', changes: ['scheduleCrews'], after: { scheduleCrews: false } }] };
(async () => {
  try {
    const refresh = context.window.PDLRoleRestrictions.refresh(); await resolve(loaded); await refresh;
    assert.match(node('#role-restrictions-content').innerHTML, /Role customization available in this phase/);
    assert.match(node('#role-restrictions-content').innerHTML, /Protected/);
    assert.match(node('#role-restrictions-content').innerHTML, /Follow user grants/);
    selections[0].value = 'block'; node('#role-restrictions-reason').value = 'Synthetic reason'; submit();
    assert.equal(calls.at(-1).input.projectManager.scheduleCrews, false);
    await resolve(preview);
    assert.equal(node('#role-restrictions-preview').hidden, false);
    assert.match(node('#role-restrictions-preview').innerHTML, /&lt;img/); assert.match(node('#role-restrictions-preview').innerHTML, /&lt;script/);
    assert.ok(!node('#role-restrictions-preview').innerHTML.includes('<img'));
    const beforeConfirm = calls.length; node('#role-restrictions-save').handlers.click(); assert.equal(calls.length, beforeConfirm, 'cannot save without confirmation');
    node('#role-restrictions-confirm').checked = true; node('#role-restrictions-save').handlers.click();
    assert.equal(calls.at(-1).input.confirm, true); assert.equal(calls.at(-1).input.previewToken, preview.previewToken);
    pending.shift().reject(new Error('Stale preview')); await flush(); assert.equal(node('#role-restrictions-preview').hidden, true);
    assert.match(node('#role-restrictions-status').textContent, /Refresh and preview again/);
    submit(); node('#role-restrictions-form').handlers.input(); await resolve(preview);
    assert.equal(node('#role-restrictions-preview').hidden, true, 'editing invalidates a pending preview');
    submit(); context.companyId = 'B'; context.renderEverything(); await resolve(preview);
    assert.equal(node('#role-restrictions-content').innerHTML, '', 'tenant change clears preview and form');
    context.currentUser = { id: 2, role: 'admin' }; const adminRefresh = context.window.PDLRoleRestrictions.refresh(); await resolve(loaded); await adminRefresh;
    assert.match(node('#role-restrictions-content').innerHTML, /Review only/);
    const adminCalls = calls.length; submit(); assert.equal(calls.length, adminCalls, 'admin cannot use stale owner form');
    context.currentUser = { id: 3, role: 'project_manager' }; context.renderEverything(); listeners.focus();
    assert.equal(node('#role-restrictions-content').innerHTML, ''); assert.equal(context.reloads, 1, 'returning PM refreshes effective grants');
    const deniedCalls = calls.length; await context.window.PDLRoleRestrictions.refresh(); assert.equal(calls.length, deniedCalls);
    const html = parse5.parse(fs.readFileSync('index.html', 'utf8')), ids = new Map();
    function walk(item) { const id = item.attrs?.find(attr => attr.name === 'id')?.value; if (id) { assert.ok(!ids.has(id), 'unique DOM id ' + id); ids.set(id, item); } for (const child of item.childNodes || []) walk(child); }
    walk(html);
    const attr = (id, key) => ids.get(id)?.attrs.find(row => row.name === key)?.value;
    assert.equal(attr('settings-tab-roles', 'aria-controls'), 'company-role-restrictions');
    assert.equal(attr('company-role-restrictions', 'aria-labelledby'), 'settings-tab-roles');
    assert.equal(attr('role-restrictions-status', 'aria-live'), 'polite');
    assert.ok(availableCompanyTabs({ role: 'admin' }, {}, 'office').includes('roles'));
    for (const role of ['project_manager', 'foreman', 'field']) assert.ok(!availableCompanyTabs({ role }, {}, 'office').includes('roles'));
    console.log('Role restriction UI: confirmation, escaping, pending preview invalidation, identity changes, admin read-only and accessibility passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
})();
