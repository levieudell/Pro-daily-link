'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_ORIGINS = Object.freeze([
  'https://esm.sh',
  'https://connect.facebook.net'
]);
const STYLE_ORIGINS = Object.freeze(['https://fonts.googleapis.com']);
const FONT_ORIGINS = Object.freeze(['https://fonts.gstatic.com']);
const CONNECT_ORIGINS = Object.freeze([
  'https://heycatch.ai',
  'https://*.heycatch.ai',
  'https://www.facebook.com'
]);

function publicHtmlFiles(root) {
  const files = fs.readdirSync(root)
    .filter(file => file.endsWith('.html'))
    .map(file => path.join(root, file));
  const comparisons = path.join(root, 'vs');
  if (fs.existsSync(comparisons)) {
    files.push(...fs.readdirSync(comparisons)
      .filter(file => file.endsWith('.html'))
      .map(file => path.join(comparisons, file)));
  }
  return files;
}

function inlineScripts(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    scripts.push({ attributes, content: match[2] || '' });
  }
  return scripts;
}

function inlineScriptHashes(root) {
  const hashes = new Set();
  for (const file of publicHtmlFiles(root)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const script of inlineScripts(html)) {
      // Inline scripts retained in legacy static pages are allowed only by an
      // exact SHA-256 hash. There is deliberately no 'unsafe-inline' escape.
      const digest = crypto.createHash('sha256').update(script.content).digest('base64');
      hashes.add(`'sha256-${digest}'`);
    }
  }
  return [...hashes].sort();
}

function contentSecurityPolicy(root) {
  const scriptSources = ["'self'", ...inlineScriptHashes(root), ...SCRIPT_ORIGINS];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSources.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${STYLE_ORIGINS.join(' ')}`,
    `font-src 'self' data: ${FONT_ORIGINS.join(' ')}`,
    "img-src 'self' data: blob: https://www.facebook.com",
    `connect-src 'self' ${CONNECT_ORIGINS.join(' ')}`
  ].join('; ');
}

module.exports = Object.freeze({
  SCRIPT_ORIGINS,
  STYLE_ORIGINS,
  FONT_ORIGINS,
  CONNECT_ORIGINS,
  publicHtmlFiles,
  inlineScripts,
  inlineScriptHashes,
  contentSecurityPolicy
});
