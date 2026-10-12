'use strict';
const crypto = require('node:crypto');
const { createCredentialDelivery } = require('./account-credential-delivery');
const { createSecretRecovery } = require('./account-secret-recovery');
const { createAccountLifecycle } = require('./account-lifecycle');
function services(store, origin, options = {}) {
  const key = options.key || crypto.randomBytes(32), clock = options.clock || Date.now, messages = [];
  const credentials = createCredentialDelivery({ key: crypto.createHash('sha256').update(key).update('mail').digest(), origin, clock, load: store.load.bind(store), commit: store.commit.bind(store), send: options.send || (async message => { messages.push(message); return { accepted: true }; }) });
  const secretRecovery = createSecretRecovery({ key: crypto.createHash('sha256').update(key).update('manual').digest(), clock });
  const lifecycle = createAccountLifecycle({ credentials, secretRecovery, proofKey: crypto.createHash('sha256').update(key).update('review').digest(), clock });
  return { credentials, lifecycle, messages, secretRecovery };
}
module.exports = { services };
