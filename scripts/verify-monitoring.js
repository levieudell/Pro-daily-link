'use strict';

const Sentry = require('@sentry/node');

async function main() {
  if (!process.env.SENTRY_DSN) throw new Error('SENTRY_DSN is not configured. No monitoring event was sent.');
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'verification', sendDefaultPii: false });
  const eventId = Sentry.captureMessage('Pro Daily Link monitoring verification', 'info');
  const delivered = await Sentry.flush(10_000);
  if (!delivered) throw new Error('Sentry did not confirm delivery within 10 seconds.');
  console.log(`Sentry verification event sent: ${eventId}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });


