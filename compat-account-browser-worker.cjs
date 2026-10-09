'use strict';
// Ordinary legacy global service, isolated fixture and no compatibility install.
for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
const { server } = require('./server');
server.listen(0, 'localhost', () => process.send({ event: 'ready', port: server.address().port }));
process.on('message', message => { if (message.event === 'close') server.close(() => process.disconnect()); });
