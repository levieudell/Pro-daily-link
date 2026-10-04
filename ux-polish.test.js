const assert = require('assert');
const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(read('manifest.webmanifest'));
const index = read('index.html');
const login = read('login.html');
const app = read('app.js');
const styles = read('styles.css');

assert.equal(manifest.start_url, '/app');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.scope, '/');
assert.ok(manifest.icons.some((icon) => icon.src === '/assets/pro-daily-link-logo.png'));
assert.match(index, /id="network-activity"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(index, /rel="manifest" href="manifest\.webmanifest"/);
assert.match(login, /rel="manifest" href="manifest\.webmanifest"/);
assert.match(app, /Create your first project/);
assert.match(app, /Create daily report/);
assert.match(styles, /prefers-reduced-motion/);
assert.match(styles, /\.network-activity/);

console.log('UX shell and installability tests passed.');
