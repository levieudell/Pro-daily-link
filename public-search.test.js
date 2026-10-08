const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {isPublicFile}=require('./public-file-policy');
for(const name of ['robots.txt','sitemap.xml']) assert(isPublicFile(__dirname,path.join(__dirname,name)));
assert(!isPublicFile(__dirname,path.join(__dirname,'data','db.json')));
const robots=fs.readFileSync('robots.txt','utf8');
assert(robots.includes('User-agent: *'));assert(!robots.includes('Disallow: /\n'));
assert(!robots.includes('User-agent: GPTBot'));assert(!robots.includes('User-agent: OAI-SearchBot'));
for(const route of ['/api/','/uploads/'])assert(robots.includes('Disallow: '+route));
assert(!robots.includes('Disallow: /guest/'),'data-free guest shell must be crawlable for noindex');
const xml=fs.readFileSync('sitemap.xml','utf8');
const urls=[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match=>match[1]);
assert.equal(urls.length,5);assert.equal(new Set(urls).size,5);
assert(urls.every(url=>url.startsWith('https://app.prodailylink.com/')));
assert(!urls.some(url=>/signup|login|guest|platform|api|app$/.test(url)));
for(const file of ['landing.html','about.html','privacy.html','terms.html']){
 const html=fs.readFileSync(file,'utf8');assert.equal((html.match(/rel="canonical"/g)||[]).length,1);
 assert(!html.includes('name="robots"'));assert(/<title>[^<]+<\/title>/.test(html));
}
for(const file of ['index.html','login.html','signup.html','guest.html','platform.html','support.html'])assert(fs.readFileSync(file,'utf8').includes('content="noindex, nofollow"'));
console.log('Public search policies, public allowlist and metadata checks passed.');
