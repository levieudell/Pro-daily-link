'use strict';
(function () {
  const Recovery = typeof OriginalOperationRecovery !== 'undefined' ? OriginalOperationRecovery : typeof require === 'function' ? require('./original-operation-recovery') : null;
  const PLATFORM_ID = '5a7f362f-e399-56e3-9458-e34b794a389d';
  function create(call, settings = {}) {
    const journal = settings.journal || (Recovery && Recovery.create(() => localStorage));
    const retire = isCurrent => {
      // A cancelled earlier view cannot retire its replacement. This callback
      // only selects DOM cleanup; it never substitutes for authorization.
      if (typeof isCurrent === 'function') { try { if (isCurrent() === false) return; } catch {} }
      if (typeof settings.retire === 'function') settings.retire();
    };
    const fail = (operationId, status) => Object.assign(Error('Review original setup operation ' + (operationId || '') + '. Current account or form changed, or original result needs review. Read its original result before submitting a different account request.'), { operationId, status, code: 'PDL_ORIGINAL_MANUAL_REVIEW' });
    const entries = () => { if (!journal) throw fail(); return journal.entries('manual'); };
    async function identity() {
      const value = await call('/api/platform/auth/me');
      if (value && (!Object.hasOwn(value, 'manualCredentialCustody') || value.manualCredentialCustody === false)) return null;
      if (value?.manualCredentialCustody !== true || value.role !== 'platform_owner' || !Number.isSafeInteger(value.id) || value.id <= 0 || !/^[a-f0-9]{64}$/.test(value.accountSessionBinding || '')) throw Error('Current platform Owner session required.');
      if (typeof value.email !== 'string' || value.email.length > 5000) throw Error('Current platform Owner session required.');
      const scope = await journal.identityDigest({ companyId: PLATFORM_ID, actorId: value.id, role: value.role, sessionBinding: value.accountSessionBinding });
      return journal.intentDigest(JSON.stringify([scope, value.email]));
    }
    function path(row) { return row.purpose === 'platform-staff-create' ? '/api/platform/manual-credentials/' + row.operationId : row.route + '/' + row.operationId; }
    async function fresh(row, accept, readOnly = false, isCurrent) {
      journal.assertOriginal(row, { readOnly });
      if (isCurrent !== undefined && (typeof isCurrent !== 'function' || isCurrent() !== true)) throw fail(row.operationId);
      if (await identity() !== row.identityDigest || accept !== undefined && (typeof accept !== 'function' || accept() !== true)) throw Error('Current account or form changed. Review original setup operation ' + row.operationId + '.');
      if (isCurrent !== undefined && (typeof isCurrent !== 'function' || isCurrent() !== true)) throw fail(row.operationId);
      journal.assertOriginal(row, { readOnly });
    }
    function result(row, value) {
      if (!value || value.operationId !== row.operationId || typeof value.setupCode !== 'string' || !/^[A-Za-z0-9_-]{6,1024}$/.test(value.setupCode)) throw fail(row.operationId);
      const expiresAt = value.expiresAt || value.setupExpiresAt;
      if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) <= Date.now() || typeof value.email !== 'string' || value.email.length > 5000) throw fail(row.operationId);
      if (row.purpose === 'platform-owner-reset' ? value.companyId !== row.target.companyId : !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.name !== 'string' || value.name.length > 500 || !['platform_owner', 'customer_success', 'onboarding', 'support', 'billing', 'engineering'].includes(value.role)) throw fail(row.operationId);
      return value;
    }
    async function recover(row, accept, isCurrent) {
      try {
        await fresh(row, accept, true, isCurrent);
        const value = await call(path(row));
        await fresh(row, accept, true, isCurrent);
        return result(row, value);
      } catch (error) { retire(isCurrent); throw fail(row.operationId, error.status); }
    }
    async function recoverOriginal(operationId, options = {}) {
      let row;
      try { row = entries().find(value => value.operationId === operationId); if (!row) throw fail(operationId); }
      catch (error) { retire(options.isCurrent); throw error; }
      return recover(row, options.accept, options.isCurrent);
    }
    async function reviewOriginal(operationId, options = {}) {
      if (options.confirmed !== true) throw fail(operationId);
      let row;
      try { row = entries().find(value => value.operationId === operationId); if (!row) throw fail(operationId); }
      catch (error) { retire(options.isCurrent); throw error; }
      const value = await recover(row, options.accept, options.isCurrent);
      try {
        if (options.isCurrent !== undefined && (typeof options.isCurrent !== 'function' || options.isCurrent() !== true) || options.accept !== undefined && (typeof options.accept !== 'function' || options.accept() !== true)) throw fail(operationId);
      } catch (error) { retire(options.isCurrent); throw error; }
      // Cleanup failure follows a known result, not an unknown save.
      try { journal.reviewed(row); } catch {
        try { await fresh(row, options.accept, true, options.isCurrent); }
        catch (error) { retire(options.isCurrent); throw Object.assign(fail(row.operationId, error.status), { knownResult: true }); }
        return { ...value, originalHandleRetained: true };
      }
      return value;
    }
    async function request(route, options = {}) {
      if (options.method !== 'POST' || !(route === '/api/platform/users' || /^\/api\/platform\/companies\/[^/]+\/owner-reset$/.test(route))) return call(route, options);
      options = { ...options, ...(options.headers ? { headers: { ...options.headers } } : {}) };
      let row;
      try {
        const pending = entries(), scope = await identity();
        if (!scope) { if (pending.length) throw fail(pending[0].operationId); return call(route, options); }
        const input = JSON.parse(options.body || '{}'), intentDigest = await journal.intentDigest(JSON.stringify([route, input]));
        const latest = entries(); row = latest[0];
        if (latest.length > 1 || row && (row.route !== route || row.identityDigest !== scope || row.intentDigest !== intentDigest)) throw fail(row?.operationId);
        if (row) return await recover(row, options.manualAccept);
        if (options.manualAccept !== undefined && (typeof options.manualAccept !== 'function' || options.manualAccept() !== true)) throw Error('Current account or form changed.');
        row = { version: 1, operationId: crypto.randomUUID(), purpose: route === '/api/platform/users' ? 'platform-staff-create' : 'platform-owner-reset', route, target: { companyId: route === '/api/platform/users' ? PLATFORM_ID : route.split('/')[4], projectId: null, resourceId: null }, identityDigest: scope, intentDigest, createdAt: new Date().toISOString() };
        journal.remember(row); await fresh(row, options.manualAccept);
        if (entries().length !== 1) throw fail(row.operationId);
        const { manualAccept, ...dispatch } = options;
        try {
          const value = await call(route, { ...dispatch, headers: { ...(options.headers || {}), 'X-PDL-Operation': row.operationId } });
          await fresh(row, manualAccept);
          return result(row, value);
        } catch (error) {
          // Read-only recovery never repeats the POST or clears a lookup 404.
          try { return await recover(row, manualAccept); } catch { throw fail(row.operationId, error.status); }
        }
      } catch (error) { retire(); throw error; }
    }
    request.originalOperations = entries;
    request.recoverOriginal = recoverOriginal;
    request.reviewOriginal = reviewOriginal;
    return request;
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { create }; return; }
  window.PDLManualCredentialClient = { create };
  api = create(api, { retire: () => { if (typeof window.pdlRetireManualCredentials === 'function') window.pdlRetireManualCredentials(); } });
  window.PDLManualCredentialRecovery = api;
})();
