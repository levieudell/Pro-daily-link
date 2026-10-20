'use strict';

const monitoring = require('../monitoring');

async function main({ env = process.env, monitor = monitoring, log = console.log } = {}) {
  if (!monitor.init(env)) throw new Error('SENTRY_DSN is missing or invalid. No monitoring event was queued.');
  const eventId = monitor.captureVerification();
  if (!eventId) throw new Error('The controlled monitoring event could not be created.');
  const flushed = await monitor.flush(10_000);
  if (!flushed) throw new Error('Sentry did not flush the queued verification event within 10 seconds.');
  log(`Controlled monitoring verification event queued and flushed: ${eventId}`);
  return eventId;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };


