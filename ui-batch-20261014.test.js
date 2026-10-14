'use strict';
// UI batch 2026-10-14: (1) real 800 weight for DM Sans on public pages so
// Chrome stops synthesizing faux-bold buttons, (2) Messages screen overflow
// guards, (3) all six project-detail tab buttons render synchronously and
// async layers only update counts — no more tabs popping in late.
const assert = require('node:assert/strict'), fs = require('node:fs');

const landing = fs.readFileSync('landing.html', 'utf8');
const login = fs.readFileSync('login.html', 'utf8');
const signup = fs.readFileSync('signup.html', 'utf8');
const guest = fs.readFileSync('guest.html', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');

// 1) Public pages load the true DM Sans 800 weight used by their stylesheets.
for (const [name, html] of [['landing', landing], ['login', login], ['signup', signup], ['guest', guest]]) {
  assert.match(html, /family=DM\+Sans:wght@400;500;600;700;800/, `${name}.html must load DM Sans 800`);
}

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
