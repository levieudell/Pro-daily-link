'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', '.audit-projects', 'uploads', 'data']);
const findings = [];
const secretPatterns = [
  ['OpenAI key', /sk-[a-zA-Z0-9_-]{20,}/g],
  ['Stripe live key', /sk_live_[a-zA-Z0-9]{16,}/g],
  ['Stripe webhook secret', /whsec_[a-zA-Z0-9]{16,}/g],
  ['Resend key', /re_[a-zA-Z0-9]{20,}/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.isFile() && entry.name !== 'package-lock.json' && fs.statSync(full).size < 2_000_000) {
      const content = fs.readFileSync(full, 'utf8');
      for (const [type, pattern] of secretPatterns) if (pattern.test(content)) findings.push({ severity: 'critical', type, file: path.relative(root, full) });
      if (/innerHTML\s*=\s*[^`'"\n]/.test(content)) findings.push({ severity: 'review', type: 'dynamic innerHTML assignment', file: path.relative(root, full) });
    }
  }
}

visit(root);
const critical = findings.filter(item => item.severity === 'critical');
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), critical: critical.length, review: findings.length - critical.length, findings }, null, 2));
if (critical.length) process.exitCode = 1;


