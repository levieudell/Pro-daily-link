const assert=require('node:assert/strict');
const fs=require('node:fs');

const read=file=>fs.readFileSync(file,'utf8');
const app=read('app.js');
const server=read('server.js');
const platform=read('platform.js');
const platformLogin=read('platform-login.html');
const platformForgot=read('platform-forgot-password.html');
const render=read('render.yaml');

assert.match(app,/let projects=\[\];\s*let team=\[\];\s*let reports=\[\];/);
for(const sample of ['Division Street Clinic','Hawthorne Health','Aaron Kim','Northstar crew'])assert.doesNotMatch(app,new RegExp(sample,'i'));
assert.doesNotMatch(server,/input\.foreman\|\|'Levi Foreman'/);
assert.match(server,/foreman:fieldRole\(req\.auth\?\.user\)\?req\.auth\.user\.name:/);
assert.doesNotMatch(platformLogin,/value="levi@prodailylink\.com"/i);
assert.doesNotMatch(platformForgot,/value="levi@prodailylink\.com"/i);
assert.doesNotMatch(platform,/value="Levi"/);
assert.match(platform,/platformUser=user/);
assert.match(render,/https:\/\/app\.prodailylink\.com/);

console.log('Hard-coded identity guard tests passed');
