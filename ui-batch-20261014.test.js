'use strict';
// UI batch 2026-10-14: (1) real bold weight so buttons are not faux-bold,
// (2) Messages screen overflow guards, (3) all six project-detail tab buttons
// render synchronously and async layers only update counts — no more tabs popping in late.
// Brand v1.0 moved marketing and auth pages from DM Sans onto self-hosted Inter (including 800).
const assert = require('node:assert/strict'), fs = require('node:fs');

const landing = fs.readFileSync('landing.html', 'utf8');
const login = fs.readFileSync('login.html', 'utf8');
const signup = fs.readFileSync('signup.html', 'utf8');
const guest = fs.readFileSync('guest.html', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const brandFonts = fs.readFileSync('assets/brand-fonts.css', 'utf8');

// 1) Marketing and auth pages load real Inter 700/800. Guest stays on DM Sans 800.
for (const [name, html] of [['landing', landing], ['login', login], ['signup', signup]]) {
  assert.match(html, /brand-fonts\.css/, `${name}.html must load self-hosted Inter and Anton`);
}
assert.match(brandFonts, /font-family:Anton/);
assert.match(brandFonts, /font-weight:700/);
assert.match(brandFonts, /font-weight:800/);
assert.match(fs.readFileSync('login.css', 'utf8'), /font-family:Inter,sans-serif/);
assert.match(fs.readFileSync('signup.css', 'utf8'), /font-family:Inter,sans-serif/);
assert.doesNotMatch(fs.readFileSync('login.css', 'utf8'), /Arial/);
assert.doesNotMatch(fs.readFileSync('signup.css', 'utf8'), /Arial/);
assert.match(guest, /family=DM\+Sans:wght@400;500;600;700;800/, 'guest.html must load DM Sans 800');

// 2) Messages screen stays inside its cards at any viewport width.
assert.match(styles, /\.msg-new-panel select\{width:100%;max-width:100%;min-width:0\}/, 'project select must fill its grid cell instead of overflowing');
assert.match(styles, /\.messages-layout>\.panel\{min-width:0\}/, 'messages grid children must be allowed to shrink');
assert.match(styles, /\.msg-reply-row input\{flex:1;min-width:0\}/, 'reply input must not force the row wider');
assert.match(styles, /\.msg-bubble p\{overflow-wrap:anywhere\}/, 'long pasted text must wrap inside bubbles');
assert.match(styles, /\.msg-thread-body\{overflow-x:hidden\}/, 'thread body must clip stray horizontal overflow');

// 3) Project detail: all tab buttons render in the base template.
assert.match(app, /data-project-detail-tab="changes">Changes <span data-project-tab-count="changes">/, 'changes tab button must be pre-rendered');
assert.match(app, /data-project-detail-tab="tickets">Tickets <span data-project-tab-count="tickets">/, 'tickets tab button must be pre-rendered');
// ...and the async layers must not append extra tab buttons anymore.
assert.doesNotMatch(app, /insertAdjacentHTML\('beforeend',`<button type="button" data-project-detail-tab=/, 'async layers must not insert tab buttons');
assert.match(app, /data-project-tab-count="changes"\]'\);if\(changesCount\)changesCount\.textContent=changes\.length/, 'changes fetch updates the pre-rendered count');
assert.match(app, /data-project-tab-count="tickets"\]'\);if\(ticketCount\)ticketCount\.textContent=tickets\.length/, 'tickets fetch updates the pre-rendered count');

console.log('ui-batch-20261014: all assertions passed');
