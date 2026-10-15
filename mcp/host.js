'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class ToolError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createHost(deps) {
  function fakeRes() {
    return {
      statusCode: 200,
      headersSent: false,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value; },
      getHeader(name) { return this.headers[name]; },
      writeHead(status, headers) {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) this.body += chunk;
        this.headersSent = true;
      }
    };
  }

  async function session(companyId, token, fn) {
    return deps.withTenantQueue(String(companyId), async () => {
      const database = await deps.requestDatabase({ headers: { 'x-pdl-company': String(companyId) }, socket: {} });
      if (!database) throw new ToolError('Company workspace not found.', 404);
      database.db = deps.freshestTenantSnapshot(database);
      const context = { ...database, pending: [], backup: null, deferResponse: deps.transactionalMode() === 'primary', response: null };
      return deps.dbContext.run(context, async () => {
        const db = deps.readDb();
        if (String(db.company?.id) !== String(companyId)) throw new ToolError('Company workspace not found.', 404);
        const stored = (db.users || []).find(user => user.id === token.userId && user.status === 'Active' && (!user.companyId || String(user.companyId) === String(db.company.id)));
        const role = stored?.role === 'office' ? 'admin' : stored?.role === 'foreman' ? 'field' : stored?.role;
        if (!stored || role !== token.role) throw new ToolError('This connection is no longer valid. Sign in again.', 401);
        const access = deps.accountAccess(db.company);
        if (access.locked) throw new ToolError(access.reason || 'This account cannot use the connector right now.', 402);
        const raw = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        db.sessions ||= [];
        db.sessions.push({ id: crypto.randomUUID(), tokenHash, userId: stored.id, companyId: db.company.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), mcpConnector: true });
        const revisionBefore = Number(db.company.persistence?.revision || 0);
        const actor = { id: stored.id, name: stored.name, role, memberId: stored.memberId ?? null, companyId: db.company.id };
        async function call(method, pathname, payload) {
          const req = new EventEmitter();
          Object.assign(req, {
            method,
            url: pathname,
            headers: { authorization: `Bearer ${raw}`, 'x-pdl-company': String(db.company.id) },
            socket: { remoteAddress: '127.0.0.1' },
            parsedBodyPromise: Promise.resolve(payload ?? {})
          });
          const res = fakeRes();
          await deps.api(req, res, new URL(pathname, 'http://mcp.local'));
          const deferred = deps.dbContext.getStore()?.response;
          let data = deferred?.data;
          if (data === undefined && res.body) {
            try { data = JSON.parse(res.body); } catch { data = { error: String(res.body) }; }
          }
          return { status: deferred?.status ?? res.statusCode, data };
        }
        try {
          return await fn({ db, actor, call });
        } finally {
          const current = deps.readDb();
          const present = (current.sessions || []).some(row => row.tokenHash === tokenHash);
          if (present) current.sessions = current.sessions.filter(row => row.tokenHash !== tokenHash);
          if (present && Number(current.company.persistence?.revision || 0) !== revisionBefore) deps.writeDb(current);
          await Promise.all(context.pending || []);
        }
      });
    });
  }

  return { session, ToolError };
}

module.exports = { createHost, ToolError };
