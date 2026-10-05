'use strict';
const enterprise = require('./enterprise-billing');
function createEnterpriseRoutes({ readDb, body, json, withCompany, persist, service }) {
  async function handle(req, res, url, platform = false) {
    const match = platform
      ? url.pathname.match(/^\/api\/platform\/companies\/([0-9a-f-]{36})\/enterprise-quotes(?:\/([0-9a-f-]{36})(?:\/(issue|cancel))?)?$/i)
      : url.pathname.match(/^\/api\/billing\/enterprise-quotes(?:\/([0-9a-f-]{36})\/checkout)?$/i);
    if (!match) return false;
    // No demo-mode bypass, and no support/admin ability to approve customer commercial terms.
    if (process.env.PDL_REQUIRE_AUTH !== '1') { json(res, 403, { error: 'Enterprise billing requires authenticated accounts.' }); return true; }
    const actor = platform ? req.platformAuth?.user : req.auth?.user;
    if (actor?.role !== (platform ? 'platform_owner' : 'owner')) { json(res, 403, { error: platform ? 'Platform Owner permission required' : 'Account owner permission required' }); return true; }
    try {
      const input = ['POST', 'PATCH'].includes(req.method) ? await body(req) : {};
      let code = 200, result;
      const task = async db => {
        if (platform && String(db.company.id) !== match[1]) throw enterprise.fail('Company not found.', 404);
        if (req.method === 'GET' && !(platform ? match[2] : match[1])) {
          result = { companyId: db.company.id, companyName: db.company.name, checkoutEnabled: enterprise.configured(),
            quotes: enterprise.list(db.company, !platform), access: enterprise.access(db.company) };
        } else if (platform && req.method === 'POST' && !match[2]) {
          result = enterprise.publicQuote(enterprise.createDraft(db, input, actor)); code = 201; await persist(db);
        } else if (platform && req.method === 'PATCH' && match[2] && !match[3]) {
          result = enterprise.publicQuote(enterprise.editDraft(db, match[2], input, actor)); await persist(db);
        } else if (platform && req.method === 'POST' && match[3] === 'issue') {
          result = enterprise.publicQuote(enterprise.issue(db, match[2], input, actor)); await persist(db);
        } else if (platform && req.method === 'POST' && match[3] === 'cancel') {
          result = enterprise.publicQuote(await service.cancel(db, match[2], input, actor));
        } else if (!platform && req.method === 'POST' && match[1]) {
          result = await service.checkout(db, match[1], input, actor);
        } else throw enterprise.fail('Method not allowed.', 405);
      };
      if (platform) await withCompany(match[1], task); else await task(readDb());
      json(res, code, result);
    } catch (error) {
      json(res, error.statusCode || 502, { error: error.statusCode ? error.message : 'Enterprise billing could not be updated. Refresh before trying again.' });
    }
    return true;
  }
  return handle;
}
module.exports = { createEnterpriseRoutes };
