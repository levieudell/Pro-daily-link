'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./content-security-policy');

const root = __dirname;
const value = policy.contentSecurityPolicy(root);
const scriptDirective = value.split('; ').find(part => part.startsWith('script-src '));

assert.ok(scriptDirective, 'script-src directive exists');
assert.equal(scriptDirective.includes("'unsafe-inline'"), false, 'executable inline JavaScript stays forbidden');
for (const origin of policy.SCRIPT_ORIGINS) assert.ok(scriptDirective.includes(origin), `script allowlist includes ${origin}`);
for (const hash of policy.inlineScriptHashes(root)) assert.ok(scriptDirective.includes(hash), 'inline script hash is present');
assert.ok(value.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"), 'Google font stylesheet and existing dynamic inline styles are allowed');
assert.ok(value.includes("font-src 'self' data: https://fonts.gstatic.com"), 'Google font files are allowed explicitly');
assert.ok(value.includes("img-src 'self' data: blob: https://www.facebook.com"), 'Meta pixel image beacon is narrowly allowed');

for (const file of policy.publicHtmlFiles(root)) {
  const html = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${path.relative(root, file)} has no CSP-blocked inline event handler`);
  for (const script of policy.inlineScripts(html)) {
    const hash = `'sha256-${require('node:crypto').createHash('sha256').update(script.content).digest('base64')}'`;
    assert.ok(scriptDirective.includes(hash), `${path.relative(root, file)} inline script is covered by an exact hash`);
  }
}

for (const [file, asset] of [
  ['login.html', 'staging-banner.js'],
  ['index.html', 'workspace-gate.js'],
  ['index.html', 'register-service-worker.js']
]) assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes(asset), `${file} loads ${asset}`);

console.log('Content Security Policy passed: executable scripts are external or exactly hashed, and third-party origins are narrowly allowed.');
