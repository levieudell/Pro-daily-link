'use strict';

const path = require('node:path');
const lib = require('./lib.cjs');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

async function readHealth() {
  const live = await fetch(`${lib.baseUrl()}/api/health/live`);
  const liveText = await live.text();
  let liveBody = null;
  try { liveBody = JSON.parse(liveText); } catch { liveBody = { unparsed: true }; }
  const health = await fetch(`${lib.baseUrl()}/api/health`);
  const healthText = await health.text();
  let healthBody = null;
  try { healthBody = JSON.parse(healthText); } catch { healthBody = { unparsed: true }; }
  const exposed = healthBody && Object.prototype.hasOwnProperty.call(healthBody, 'commit');
  return {
    base: lib.baseUrl(),
    liveStatus: live.status,
    liveKind: liveBody?.kind || '',
    healthStatus: health.status,
    healthKind: healthBody?.kind || '',
    healthOk: healthBody?.ok === true,
    commitExposed: exposed,
    commit: exposed ? healthBody.commit : null,
    time: healthBody?.time || liveBody?.time || ''
  };
}

async function once() {
  const health = await readHealth();
  const accounts = [];
  let passwordsReady = true;
  for (const role of ['field', 'owner']) {
    try {
      accounts.push(await lib.loginAccount(role));
    } catch (error) {
      passwordsReady = false;
      accounts.push({ ok: false, role, error: error.code === 'MISSING_PASSWORD' ? error.message : 'login check failed' });
    }
  }
  const newBuild = health.liveStatus === 200 && health.liveKind === 'liveness' && health.healthKind === 'operational-readiness';
  const loginsOk = accounts.every(account => account.ok && account.cedarGrove);
  const ready = health.healthStatus === 200 && newBuild && loginsOk;
  return {
    ready,
    newBuild,
    passwordsReady,
    health,
    accounts: accounts.map(account => ({
      ok: account.ok === true,
      role: account.role,
      loginStatus: account.loginStatus || null,
      meStatus: account.meStatus || null,
      accountRole: account.accountRole || '',
      name: account.name || '',
      companyName: account.companyName || '',
      cedarGrove: account.cedarGrove === true,
      error: account.error || ''
    }))
  };
}

async function main() {
  const wait = process.argv.includes('--wait');
  const timeoutMs = Number(arg('--timeout-ms', wait ? 900000 : 0)) || 0;
  const started = Date.now();
  let report = await once();
  while (wait && !report.newBuild && Date.now() - started < timeoutMs) {
    await lib.sleep(15000);
    report = await once();
  }
  report.waitedMs = Date.now() - started;
  const file = path.join(lib.artifactsRoot(), 'doctor.json');
  lib.writeJson(file, report);
  process.stdout.write(`${JSON.stringify({ ready: report.ready, newBuild: report.newBuild, healthStatus: report.health.healthStatus, liveStatus: report.health.liveStatus, commitExposed: report.health.commitExposed, accounts: report.accounts, evidence: file })}\n`);
  process.exit(report.ready ? 0 : 1);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
