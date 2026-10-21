'use strict';

const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createOAuth, formBody, normalizeRole, allowedRole } = require('./oauth');
const { createHost } = require('./host');
const { registerTools } = require('./tools');
const { allow, limit } = require('./rate-limit');

const PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
  '/mcp'
]);

function pathnameOf(url) {
  return url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 1_000_000) {
        settled = true;
        const error = new Error('Request is too large');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => { if (!settled) resolve(raw); });
    req.on('error', reject);
  });
}

async function readBody(req) {
  const raw = await readRaw(req);
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try { return raw ? JSON.parse(raw) : {}; } catch (error) { error.statusCode = 400; throw error; }
  }
  return formBody(raw);
}

function createMcpHttp(deps) {
  const cloudId = deps.stableUuid('mcp-oauth', 'pro-daily-link-connector');
  const oauth = createOAuth({
    file: path.join(path.dirname(deps.dbFile), 'mcp-oauth.json'),
    assertWrite: deps.assertWritesAllowed,
    async loadCloud() {
      if (!deps.supabase.configured()) return null;
      const snapshot = await deps.supabase.loadCompanySnapshot(cloudId);
      return snapshot?.mcpOauth || null;
    },
    async saveCloud(data) {
      if (!deps.supabase.configured()) return;
      await deps.supabase.saveCompanySnapshot({ company: { id: cloudId, name: 'Pro Daily Link MCP connector', mcpConnector: true }, mcpOauth: data });
    }
  });
  const host = createHost(deps);

  async function accountsFor(email, password) {
    const normalized = String(email || '').trim().toLowerCase();
    let tenants = deps.tenantDatabases();
    if (deps.supabase.configured()) {
      try { tenants = deps.mergeTenantSnapshots(tenants, await deps.supabase.listCompanySnapshots(), deps.platformCloudId); } catch (error) { console.error('MCP login tenant lookup failed', error.message); }
    }
    const accounts = [];
    for (const db of tenants) {
      if (!db?.company?.id || db.company.mcpConnector || db.mcpOauth || db.company.archivedDuplicate) continue;
      const user = (db.users || []).find(row => row.status === 'Active' && String(row.email || '').trim().toLowerCase() === normalized);
      if (!user || user.mustSetPassword || !deps.verifyCredential(password, user.passwordSalt, user.passwordHash)) continue;
      const role = normalizeRole(user.role);
      const access = deps.accountAccess(db.company);
      accounts.push({ allowed: allowedRole(role) && !access.locked, companyId: db.company.id, companyName: db.company.name, userId: user.id, role: user.role, name: user.name, memberId: user.memberId || null });
    }
    return accounts;
  }

  function matches(url) {
    return PATHS.has(pathnameOf(url));
  }

  function send(res, status, data, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...extra
    });
    res.end(JSON.stringify(data));
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  async function handleMcp(req, res) {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return send(res, 405, { error: 'Method not allowed' });
    }
    const auth = await oauth.authenticate(req.headers.authorization);
    if (!auth) {
      const origin = oauth.originOf(req);
      res.setHeader('WWW-Authenticate', `Bearer realm="pro-daily-link", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
      return send(res, 401, { error: 'Authentication required' });
    }
    const decision = allow(`${auth.companyId}:${auth.userId}`, limit());
    if (!decision.ok) return send(res, 429, { error: 'Too many requests. Please wait and try again.' }, { 'Retry-After': '60' });
    const mcp = new McpServer({ name: 'pro-daily-link', version: '1.0.0' });
    registerTools(mcp, { auth, host, oauth, deps });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    }
  }

  async function handle(req, res, url) {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    const pathname = pathnameOf(url);
    if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') return send(res, 200, oauth.protectedResource(oauth.originOf(req)));
    if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/oauth-authorization-server/mcp') return send(res, 200, oauth.metadata(oauth.originOf(req)));
    if (pathname === '/oauth/register') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const result = await oauth.register(await readBody(req));
      return send(res, result.status, result.body);
    }
    if (pathname === '/oauth/authorize') {
      if (req.method === 'GET') return oauth.showAuthorize(req, res, url);
      if (req.method === 'POST') return oauth.postAuthorize(req, res, await readBody(req), accountsFor);
      return send(res, 405, { error: 'Method not allowed' });
    }
    if (pathname === '/oauth/token') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const result = await oauth.token(req, await readBody(req));
      return send(res, result.status, result.body);
    }
    if (pathname === '/oauth/revoke') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const result = await oauth.revoke(req, await readBody(req));
      return send(res, result.status, result.body);
    }
    if (pathname === '/mcp') return handleMcp(req, res);
    return send(res, 404, { error: 'Not found' });
  }

  return { matches, handle, allow };
}

module.exports = { createMcpHttp };
