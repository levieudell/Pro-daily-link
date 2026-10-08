'use strict';
const $ = s => document.querySelector(s), params = new URLSearchParams(location.search);
let companyId = params.get('tenant') || '', scoped = false, submitIntent = false, submitting = false;
function rememberCompany(id) {
  companyId = id || '';
  try { if (companyId) localStorage.setItem('pdl-company-id', companyId); } catch {}
  $('#forgot-link').href = '/forgot-password.html' + (companyId ? '?tenant=' + encodeURIComponent(companyId) : '');
}
rememberCompany(companyId);
async function locateCompany(email) {
  const response = await fetch('/api/auth/company', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(companyId ? { 'X-PDL-Company': companyId } : {}) }, body: JSON.stringify({ email }) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Unable to locate your company account.');
  if (!data.companyId || scoped && companyId && data.companyId !== companyId) throw Error('The selected company could not be verified.');
  rememberCompany(data.companyId); return companyId;
}
async function call(path, input) {
  await locateCompany(input.email);
  const response = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) { const error = Error(data.error || 'Sign-in could not be completed.'); error.code = data.code; throw error; }
  return data;
}
function enter(user) {
  if (scoped && user) return location.replace(window.WorkspaceEntry.workspace(user, location.hash));
  location.replace('/app?tenant=' + encodeURIComponent(companyId) + '#' + (location.hash ? window.WorkspaceEntry.route(location.hash) : 'dashboard'));
}
async function resumeSavedSession() {
  try {
    const modeResponse = await fetch('/api/config', { credentials: 'include', cache: 'no-store' });
    if (!modeResponse.ok) return;
    const mode = await modeResponse.json(); scoped = mode.scopedWorkspace === true;
    if (scoped) { $('#forgot-link').hidden = true; $('.auth-card > a.secondary').hidden = true; $('#entry-help').hidden = false; }
    let remembered = params.get('tenant') || '';
    if (!remembered) try { remembered = localStorage.getItem('pdl-company-id') || ''; } catch {}
    const response = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store', headers: { ...(remembered ? { 'X-PDL-Company': remembered } : {}) } });
    if (!response.ok) return;
    const user = await response.json();
    // This probe renews its cookie. Wait for settlement before credential login.
    if (submitIntent) return;
    rememberCompany(user.companyId || remembered); $('#message').textContent = 'Opening your workspace.'; enter(scoped ? user : undefined);
  } catch {}
}
const initialProbe = resumeSavedSession();
function closeSetup() { const modal = $('#setup-modal'); if (modal.open) modal.close(); $('#claim').reset(); $('#claim-message').textContent = ''; }
$('#close-setup').onclick = closeSetup; $('#cancel-setup').onclick = closeSetup;
$('#toggle-password').onclick = () => {
  const field = $('#password'), button = $('#toggle-password'), show = field.type === 'password';
  field.type = show ? 'text' : 'password'; button.setAttribute('aria-label', (show ? 'Hide' : 'Show') + ' password'); button.title = (show ? 'Hide' : 'Show') + ' password';
  button.querySelector('.icon-show').hidden = show; button.querySelector('.icon-hide').hidden = !show; field.focus();
};
$('#login').onsubmit = async event => {
  event.preventDefault(); if (submitting) return;
  submitting = submitIntent = true; const button = $('#login button[type=submit]'); button.disabled = true; $('#message').textContent = 'Signing in.';
  try { await initialProbe; await call('/api/auth/login', { email: $('#email').value, password: $('#password').value }); enter(); }
  catch (error) {
    if (error.code === 'PASSWORD_SETUP_REQUIRED') {
      if (scoped) $('#message').textContent = 'Password setup is unavailable in this draft. Contact your company owner.';
      else { $('#code').value = $('#password').value; $('#message').textContent = ''; $('#setup-modal').showModal(); $('#new-password').focus(); }
    } else $('#message').textContent = error.message;
  } finally { submitting = submitIntent = false; button.disabled = false; }
};
$('#claim').onsubmit = async event => {
  event.preventDefault(); if (scoped) return;
  const password = $('#new-password').value;
  if (password !== $('#confirm-password').value) { $('#claim-message').textContent = 'Passwords do not match.'; return; }
  $('#claim-message').textContent = 'Setting up your account.';
  try { await call('/api/auth/claim', { email: $('#email').value, temporaryPassword: $('#code').value, password }); $('#claim-message').textContent = 'Password created. Signing you in.'; await call('/api/auth/login', { email: $('#email').value, password }); enter(); }
  catch (error) { $('#claim-message').textContent = error.message; }
};
