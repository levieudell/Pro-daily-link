'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCOPES = ['daily:read', 'daily:write'];
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const TICKET_TTL_MS = 10 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function timingEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function emptyStore() {
  return { clients: [], codes: [], tokens: [], tickets: [], idempotency: [] };
}

function createStore({ file, loadCloud, saveCloud, assertWrite = () => {} }) {
  let chain = Promise.resolve();
  let primed = false;
  let readOnlyCloud = null;
  async function read() {
    if (!primed) {
      primed = true;
      if (!fs.existsSync(file) && loadCloud) {
        try {
          const cloud = await loadCloud();
          if (cloud && typeof cloud === 'object') {
            const normalized = { ...emptyStore(), ...cloud };
            try {
              assertWrite();
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, JSON.stringify(normalized));
            } catch (error) {
              if (error?.code !== 'MAINTENANCE_READ_ONLY') throw error;
              // The cloud snapshot is already authoritative read data. Keep a
              // private in-memory copy so existing connector tokens continue
              // to authenticate while maintenance prevents cache hydration.
              readOnlyCloud = normalized;
            }
          }
        } catch (error) {
          console.error('MCP OAuth cloud load failed', error.message);
        }
      }
    }
    try {
      if (!fs.existsSync(file)) {
        // Updates mutate their input before the write fence rejects them, so
        // never return the retained snapshot by reference.
        return readOnlyCloud ? JSON.parse(JSON.stringify(readOnlyCloud)) : emptyStore();
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...emptyStore(), ...parsed };
    } catch {
      return emptyStore();
    }
  }
  function write(data) {
    assertWrite();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  function update(fn) {
    const run = chain.then(async () => {
      const data = await read();
      const now = Date.now();
      data.codes = (data.codes || []).filter(row => Date.parse(row.expiresAt) > now && !row.used);
      data.tickets = (data.tickets || []).filter(row => Date.parse(row.expiresAt) > now);
      data.tokens = (data.tokens || []).filter(row => Date.parse(row.refreshExpiresAt) > now && !row.revoked);
      data.idempotency = (data.idempotency || []).filter(row => Date.parse(row.expiresAt) > now).slice(-2000);
      const result = await fn(data);
      assertWrite();
      write(data);
      if (saveCloud) {
        assertWrite();
        saveCloud(data).catch(error => console.error('MCP OAuth cloud save failed', error.message));
      }
      return result;
    });
    chain = run.then(() => {}, () => {});
    return run;
  }
  return { read, update };
}

function normalizeRole(role) {
  if (role === 'office') return 'admin';
  if (role === 'foreman') return 'field';
  return role || '';
}

function allowedRole(role) {
  return ['owner', 'admin', 'project_manager', 'field'].includes(normalizeRole(role));
}

function roleLabel(role) {
  if (role === 'field') return 'Field user';
  if (role === 'owner') return 'Account owner';
  if (role === 'project_manager') return 'Project manager';
  return 'Office admin';
}

function parseScopes(value) {
  const requested = String(value || '').split(/[\s,]+/).filter(Boolean);
  if (!requested.length) return [...SCOPES];
  const unique = [...new Set(requested)];
  if (unique.some(scope => !SCOPES.includes(scope))) return { error: 'invalid_scope' };
  return unique;
}

function validRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'http:' && local;
  } catch {
    return false;
  }
}

function pkce(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ''))) return false;
  const digest = crypto.createHash('sha256').update(String(verifier)).digest('base64url');
  return timingEqual(digest, challenge);
}

function resourceMatches(origin, resource) {
  if (!resource) return true;
  const expected = `${origin}/mcp`;
  const value = String(resource).replace(/\/$/, '');
  return value === expected;
}

function formBody(raw) {
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light;--ink:#10251e;--muted:#4d6158;--line:#d5e0da;--paper:#f6f4ef;--card:#fff}
  body{margin:0;font-family:Georgia,serif;background:var(--paper);color:var(--ink)}
  main{max-width:32rem;margin:0 auto;padding:2.5rem 1.25rem}
  h1{font-size:1.7rem;line-height:1.15;margin:0 0 .4rem}
  p,li{line-height:1.45} .muted{color:var(--muted)}
  form,section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.1rem}
  label{display:block;font-size:.85rem;margin:.8rem 0 .25rem}
  input,select{width:100%;box-sizing:border-box;font:inherit;padding:.65rem .7rem;border:1px solid var(--line);border-radius:10px}
  button{margin-top:1rem;font:inherit;background:var(--ink);color:#fff;border:0;border-radius:999px;padding:.7rem 1.1rem;cursor:pointer}
  button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line);margin-left:.5rem}
  .error{color:#8d2b2b;font-size:.92rem}
  ul{padding-left:1.1rem}
  </style></head><body><main>${body}</main></body></html>`;
}

function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function loginPage({ clientName, query, error }) {
  const fields = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'].map(name => hidden(name, query[name] || '')).join('');
  return page('Connect Pro Daily Link', `<p class="muted">AI connector</p><h1>Sign in to connect</h1><p>${escapeHtml(clientName || 'This assistant')} is asking to connect to Pro Daily Link. Use the email and password you already use in the app.</p><form method="post" action="/oauth/authorize">${fields}<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<button type="submit">Continue</button></form>`);
}

function accessNotes(accounts) {
  const roles = new Set(accounts.map(account => account.role));
  const notes = [];
  if (roles.has('field')) notes.push('A field connection only sees your own assignments, crew, and dailies.');
  if (roles.has('project_manager')) notes.push('A project manager connection only sees assigned projects. It can save drafts and update drafts or needs-review reports. It cannot approve.');
  if (roles.has('owner') || roles.has('admin')) notes.push('An owner or office connection can read the company and save drafts. It still cannot approve.');
  return notes.map(note => `<p class="muted">${escapeHtml(note)}</p>`).join('');
}

function consentPage({ clientName, ticket, accounts, scopes, selected }) {
  const choices = accounts.length > 1
    ? `<label>Company<select name="companyId">${accounts.map(account => `<option value="${escapeHtml(account.companyId)}"${account.companyId === selected ? ' selected' : ''}>${escapeHtml(account.companyName)} · ${escapeHtml(roleLabel(account.role))}</option>`).join('')}</select></label>`
    : `${hidden('companyId', accounts[0].companyId)}<p><strong>${escapeHtml(accounts[0].companyName)}</strong><br><span class="muted">${escapeHtml(accounts[0].name)} · ${escapeHtml(roleLabel(accounts[0].role))}</span></p>`;
  const scopeText = scopes.map(scope => scope === 'daily:read' ? 'Read projects, estimates, and dailies you are allowed to see' : 'Clock in and out, save draft dailies, and submit a daily for office review').join('</li><li>');
  return page('Allow connector', `<p class="muted">AI connector</p><h1>Allow ${escapeHtml(clientName || 'this assistant')}?</h1><section><p>The assistant cannot approve a daily. Approved reports stay locked.</p><ul><li>${scopeText}</li></ul>${accessNotes(accounts)}</section><form method="post" action="/oauth/authorize">${hidden('ticket', ticket)}${choices}<button name="decision" value="allow" type="submit">Allow</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></form>`);
}

function refusalPage(message) {
  return page('Cannot connect', `<p class="muted">AI connector</p><h1>This sign-in cannot connect</h1><p>${escapeHtml(message)}</p>`);
}

function createOAuth(options) {
  const store = createStore(options);
  function originOf(req) {
    const configured = String(process.env.PDL_PUBLIC_URL || '').trim().replace(/\/$/, '');
    if (configured) return configured;
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  function metadata(origin) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: SCOPES,
      service_documentation: `${origin}/MCP.md`
    };
  }
  function protectedResource(origin) {
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}/MCP.md`
    };
  }
  async function register(body) {
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(uri => String(uri)) : [];
    if (!redirects.length || redirects.length > 10 || redirects.some(uri => !validRedirect(uri))) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'redirect_uris must be https, or http on localhost.' } };
    const method = ['none', 'client_secret_basic', 'client_secret_post'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
    const clientId = `pdl_${randomToken()}`;
    let clientSecret = null;
    let clientSecretHash = null;
    if (method !== 'none') {
      clientSecret = randomToken();
      clientSecretHash = sha256(clientSecret);
    }
    const client = {
      clientId,
      clientSecretHash,
      clientName: String(body.client_name || 'AI connector').slice(0, 120),
      redirectUris: redirects,
      tokenEndpointAuthMethod: method,
      createdAt: new Date().toISOString()
    };
    await store.update(data => { data.clients.push(client); });
    return {
      status: 201,
      body: {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        client_name: client.clientName,
        redirect_uris: redirects,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: method,
        client_id_issued_at: Math.floor(Date.now() / 1000)
      }
    };
  }
  async function clientFromRequest(req, body) {
    const data = await store.read();
    let clientId = body.client_id || '';
    let secret = body.client_secret || '';
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const index = decoded.indexOf(':');
      if (index >= 0) {
        clientId = decodeURIComponent(decoded.slice(0, index));
        secret = decodeURIComponent(decoded.slice(index + 1));
      }
    }
    const client = (data.clients || []).find(row => row.clientId === clientId);
    if (!client) return null;
    if (client.tokenEndpointAuthMethod === 'none') return client;
    if (!secret || !timingEqual(sha256(secret), client.clientSecretHash || '')) return null;
    return client;
  }
  function authorizeQuery(url) {
    return {
      client_id: url.searchParams.get('client_id') || '',
      redirect_uri: url.searchParams.get('redirect_uri') || '',
      state: url.searchParams.get('state') || '',
      code_challenge: url.searchParams.get('code_challenge') || '',
      code_challenge_method: url.searchParams.get('code_challenge_method') || '',
      scope: url.searchParams.get('scope') || '',
      resource: url.searchParams.get('resource') || '',
      response_type: url.searchParams.get('response_type') || ''
    };
  }
  async function validateAuthorize(origin, query) {
    const data = await store.read();
    const client = (data.clients || []).find(row => row.clientId === query.client_id);
    if (!client) return { error: 'Unknown client. Register the connector and try again.' };
    if (!client.redirectUris.includes(query.redirect_uri)) return { error: 'That redirect URL is not registered for this connector.', client };
    if (query.response_type !== 'code') return { error: 'response_type must be code.', client, redirect: true };
    if (query.code_challenge_method !== 'S256' || !query.code_challenge) return { error: 'PKCE S256 is required.', client, redirect: true };
    if (!query.state) return { error: 'state is required.', client, redirect: true };
    if (!resourceMatches(origin, query.resource)) return { error: 'resource must be this connector URL.', client, redirect: true };
    const scopes = parseScopes(query.scope);
    if (scopes.error) return { error: 'Unknown scope. Use daily:read and daily:write.', client, redirect: true };
    return { client, scopes };
  }
  function redirectError(res, redirectUri, state, error, description) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }
  async function showAuthorize(req, res, url) {
    const origin = originOf(req);
    const query = authorizeQuery(url);
    const checked = await validateAuthorize(origin, query);
    if (checked.error && checked.redirect && checked.client) return redirectError(res, query.redirect_uri, query.state, 'invalid_request', checked.error);
    res.writeHead(checked.error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage({ clientName: checked.client?.clientName, query, error: checked.error || '' }));
  }
  async function postAuthorize(req, res, body, readLogin) {
    const origin = originOf(req);
    if (body.ticket && body.decision) return finishConsent(req, res, body, origin);
    const query = body;
    const checked = await validateAuthorize(origin, query);
    if (checked.error && checked.redirect && checked.client) return redirectError(res, query.redirect_uri, query.state, 'invalid_request', checked.error);
    if (checked.error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(loginPage({ query, error: checked.error }));
    }
    const accounts = await readLogin(body.email, body.password);
    const eligible = accounts.filter(account => account.allowed && allowedRole(account.role));
    if (!accounts.length) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(loginPage({ clientName: checked.client.clientName, query, error: 'Email or password does not match a Pro Daily Link sign-in.' }));
    }
    if (!eligible.length) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(refusalPage('The AI connector is available to the account owner, office admins, project managers, and field users.'));
    }
    const ticket = randomToken();
    await store.update(data => {
      data.tickets.push({
        id: ticket,
        clientId: checked.client.clientId,
        redirectUri: query.redirect_uri,
        state: query.state,
        codeChallenge: query.code_challenge,
        scopes: checked.scopes,
        resource: query.resource || `${origin}/mcp`,
        accounts: eligible.map(account => ({ companyId: account.companyId, companyName: account.companyName, userId: account.userId, role: normalizeRole(account.role), name: account.name, memberId: account.memberId || null })),
        expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString()
      });
    });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `pdl_mcp_login=${ticket}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600${secure}` });
    res.end(consentPage({ clientName: checked.client.clientName, ticket, accounts: eligible.map(account => ({ ...account, role: normalizeRole(account.role) })), scopes: checked.scopes }));
  }
  async function finishConsent(req, res, body, origin) {
    const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('pdl_mcp_login='))?.slice('pdl_mcp_login='.length) || '';
    if (!cookie || cookie !== body.ticket) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(refusalPage('The sign-in step expired. Start the connection again.'));
    }
    const data = await store.read();
    const ticket = (data.tickets || []).find(row => row.id === body.ticket && Date.parse(row.expiresAt) > Date.now());
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(refusalPage('The sign-in step expired. Start the connection again.'));
    }
    if (body.decision !== 'allow') {
      await store.update(storeData => { storeData.tickets = storeData.tickets.filter(row => row.id !== ticket.id); });
      return redirectError(res, ticket.redirectUri, ticket.state, 'access_denied', 'The connection was denied.');
    }
    const account = ticket.accounts.find(row => String(row.companyId) === String(body.companyId)) || (ticket.accounts.length === 1 ? ticket.accounts[0] : null);
    if (!account || !allowedRole(account.role)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(refusalPage('Choose an owner, office admin, project manager, or field user company.'));
    }
    const code = randomToken();
    await store.update(storeData => {
      storeData.tickets = storeData.tickets.filter(row => row.id !== ticket.id);
      storeData.codes.push({
        codeHash: sha256(code),
        clientId: ticket.clientId,
        redirectUri: ticket.redirectUri,
        userId: account.userId,
        companyId: account.companyId,
        role: account.role,
        name: account.name,
        memberId: account.memberId,
        scopes: ticket.scopes,
        codeChallenge: ticket.codeChallenge,
        resource: ticket.resource || `${origin}/mcp`,
        expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
        used: false
      });
    });
    const url = new URL(ticket.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', ticket.state);
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': 'pdl_mcp_login=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0' });
    res.end();
  }
  async function token(req, body) {
    const origin = originOf(req);
    const client = await clientFromRequest(req, body);
    if (!client) return { status: 401, body: { error: 'invalid_client' } };
    if (body.grant_type === 'authorization_code') return exchangeCode(client, body, origin);
    if (body.grant_type === 'refresh_token') return refresh(client, body, origin);
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }
  async function exchangeCode(client, body, origin) {
    if (!resourceMatches(origin, body.resource)) return { status: 400, body: { error: 'invalid_target', error_description: 'resource must be the Pro Daily Link connector URL.' } };
    const codeHash = sha256(body.code || '');
    let issued = null;
    const failure = await store.update(data => {
      const code = (data.codes || []).find(row => timingEqual(row.codeHash, codeHash));
      if (!code || code.used || Date.parse(code.expiresAt) <= Date.now()) return 'invalid_grant';
      if (code.clientId !== client.clientId || code.redirectUri !== body.redirect_uri) return 'invalid_grant';
      if (!pkce(body.code_verifier, code.codeChallenge)) return 'invalid_grant';
      if (body.resource && code.resource && String(body.resource).replace(/\/$/, '') !== String(code.resource).replace(/\/$/, '')) return 'invalid_target';
      code.used = true;
      data.codes = data.codes.filter(row => row !== code);
      issued = issueToken(data, { ...code, clientId: client.clientId });
      return null;
    });
    if (failure) return { status: 400, body: { error: failure === 'invalid_target' ? 'invalid_target' : 'invalid_grant' } };
    return { status: 200, body: issued };
  }
  function issueToken(data, source) {
    const access = `pdlm_${randomToken()}`;
    const refresh = `pdlr_${randomToken()}`;
    const now = Date.now();
    data.tokens.push({
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      family: source.family || crypto.randomUUID(),
      clientId: source.clientId,
      userId: source.userId,
      companyId: String(source.companyId),
      role: normalizeRole(source.role),
      name: source.name,
      memberId: source.memberId || null,
      scopes: source.scopes,
      resource: source.resource,
      accessExpiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
      revoked: false
    });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: source.scopes.join(' ') };
  }
  async function refresh(client, body, origin) {
    if (body.resource && !resourceMatches(origin, body.resource)) return { status: 400, body: { error: 'invalid_target' } };
    const refreshHash = sha256(body.refresh_token || '');
    let issued = null;
    const failure = await store.update(data => {
      const tokenRow = (data.tokens || []).find(row => timingEqual(row.refreshHash, refreshHash) && !row.revoked);
      if (!tokenRow || tokenRow.clientId !== client.clientId || Date.parse(tokenRow.refreshExpiresAt) <= Date.now()) return 'invalid_grant';
      tokenRow.revoked = true;
      const scopes = body.scope ? parseScopes(body.scope) : tokenRow.scopes;
      if (scopes.error || scopes.some(scope => !tokenRow.scopes.includes(scope))) return 'invalid_scope';
      issued = issueToken(data, { ...tokenRow, scopes, family: tokenRow.family, clientId: client.clientId });
      return null;
    });
    if (failure) return { status: 400, body: { error: failure } };
    return { status: 200, body: issued };
  }
  async function revoke(req, body) {
    const client = await clientFromRequest(req, body);
    if (!client) return { status: 401, body: { error: 'invalid_client' } };
    const hash = sha256(body.token || '');
    await store.update(data => {
      for (const tokenRow of data.tokens || []) {
        if (tokenRow.clientId === client.clientId && (timingEqual(tokenRow.accessHash, hash) || timingEqual(tokenRow.refreshHash, hash))) tokenRow.revoked = true;
      }
      data.tokens = data.tokens.filter(row => !row.revoked);
    });
    return { status: 200, body: { revoked: true } };
  }
  async function authenticate(header) {
    const token = String(header || '').startsWith('Bearer ') ? String(header).slice(7) : '';
    if (!token.startsWith('pdlm_')) return null;
    const data = await store.read();
    const hash = sha256(token);
    const row = (data.tokens || []).find(item => timingEqual(item.accessHash, hash) && !item.revoked && Date.parse(item.accessExpiresAt) > Date.now());
    if (!row || !allowedRole(row.role)) return null;
    return { userId: row.userId, companyId: String(row.companyId), role: normalizeRole(row.role), name: row.name, memberId: row.memberId, scopes: row.scopes || [], clientId: row.clientId };
  }
  async function idempotency(auth, tool, key, requestHash, producer) {
    const storageKey = `${auth.companyId}:${auth.userId}:${tool}:${key}`;
    const existing = ((await store.read()).idempotency || []).find(row => row.storageKey === storageKey && Date.parse(row.expiresAt) > Date.now());
    if (existing) {
      if (existing.requestHash !== requestHash) {
        const error = new Error('This idempotency key was already used for a different request.');
        error.statusCode = 409;
        throw error;
      }
      return existing.result;
    }
    const result = await producer();
    await store.update(data => {
      data.idempotency = (data.idempotency || []).filter(row => row.storageKey !== storageKey);
      data.idempotency.push({ storageKey, requestHash, result, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    });
    return result;
  }
  return { metadata, protectedResource, register, showAuthorize, postAuthorize, token, revoke, authenticate, idempotency, originOf, formBody, SCOPES, normalizeRole, allowedRole };
}

module.exports = { createOAuth, formBody, SCOPES, normalizeRole, allowedRole };
