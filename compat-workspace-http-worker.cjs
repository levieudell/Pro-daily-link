'use strict';
const fs = require('node:fs');
for (const key of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[key] = '';
const { A } = require('./compat-account-fixture'), { services } = require('./compat-lifecycle-fixture'), { CompatTenantRepository } = require('./database/compat-tenant-repository');
const repository = new CompatTenantRepository({ connectionString: process.env.TEST_COMPAT_DATABASE_URL, companyId: A, synthetic: true });
const key = fs.readFileSync(process.env.TEST_COMPAT_LIFECYCLE_KEY_FILE); if (key.length !== 32) throw Error('Synthetic worker key required');
let heldCommit = false, releaseCommit, loseAck = false, holdFinal = false, loadCount = 0, releaseFinal;
const store = {
  async load(id) { loadCount++; if (holdFinal && loadCount === 2) { process.send({ event: 'final-held' }); await new Promise(resolve => { releaseFinal = resolve; }); holdFinal = false; } return repository.load(id); },
  async commit(...args) { if (heldCommit) { process.send({ event: 'commit-held' }); await new Promise(resolve => { releaseCommit = resolve; }); heldCommit = false; } const result = await repository.commit(...args); if (loseAck) { loseAck = false; throw Object.assign(Error('Synthetic lost COMMIT acknowledgement'), { code: 'PDL_COMMIT_OUTCOME_UNKNOWN', statusCode: 503 }); } return result; }
};
const { server, installCompatibilityAccountTests } = require('./server'); let uninstall;
server.listen(0, '127.0.0.1', () => { const origin = 'http://127.0.0.1:' + server.address().port; const fixture = services(store, process.env.TEST_COMPAT_LIFECYCLE_ORIGIN || origin, { key }); uninstall = installCompatibilityAccountTests({ synthetic: true, companyId: A, origin: process.env.TEST_COMPAT_LIFECYCLE_ORIGIN || origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace:true, workspaceKey:key }); process.send({ event: 'ready', origin }); });
process.on('message', async message => {
  if (message.event === 'hold-commit') { heldCommit = true; process.send({ event: 'armed' }); }
  if (message.event === 'release-commit') releaseCommit?.();
  if (message.event === 'hold-final') { holdFinal = true; loadCount = 0; process.send({ event: 'armed' }); }
  if (message.event === 'release-final') releaseFinal?.();
  if (message.event === 'lose-ack') { loseAck = true; process.send({ event: 'armed' }); }
  if (message.event === 'close') { uninstall?.(); server.close(async () => { await repository.close(); process.disconnect(); }); }
});
