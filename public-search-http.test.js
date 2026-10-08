'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-search-http-'));
Object.assign(process.env,{PDL_DB_FILE:path.join(temp,'db.json'),PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_PLATFORM_KEY:'synthetic-search-policy-platform-key'});
for(const key of ['SENTRY_DSN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','OPENAI_API_KEY'])delete process.env[key];
const db=JSON.parse(fs.readFileSync(path.join(__dirname,'data/db.json'),'utf8'));
const sentinel='SYNTHETIC_PRIVATE_SEARCH_SENTINEL',token='synthetic-search-session';
db.company.name=sentinel;db.users=[{id:919,companyId:db.company.id,name:sentinel,email:'seo@example.test',role:'owner',status:'Active'}];
db.sessions=[{userId:919,companyId:db.company.id,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString()}];
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(db));fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],sessions:[],blogPosts:[]}));
const realFetch=global.fetch;let base;
global.fetch=(url,options)=>{assert(String(url).startsWith(base),'HTTP tests must never call an external provider');return realFetch(url,options);};
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
const get=async(route,headers={})=>{const response=await fetch(base+route,{headers,redirect:'manual'});return {response,text:await response.text()};};
try{
 for(const route of ['/','/landing.html','/about.html','/privacy.html','/terms.html']){
  const {response,text}=await get(route);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);assert(!text.includes(sentinel));assert.match(text,/rel="canonical" href="https:\/\/app.prodailylink.com\//);assert(!text.includes('name="robots"'));
 }
 const root=await get('/'),alias=await get('/landing.html');assert.equal(root.text,alias.text);
 const loggedIn=await get('/',{cookie:'pdl_session='+token});assert.equal(loggedIn.text,root.text,'public HTML never embeds tenant information');
 const robots=await get('/robots.txt'),sitemap=await get('/sitemap.xml');assert.equal(robots.response.status,200);assert.match(robots.response.headers.get('content-type'),/text\/plain/);assert.equal(sitemap.response.status,200);assert.match(sitemap.response.headers.get('content-type'),/application\/xml/);assert(!sitemap.text.includes(sentinel));
 for(const route of ['/signup.html?plan=starter&utm_source=chatgpt','/login.html','/app','/index.html','/platform.html','/guest/'+'a'.repeat(48),'/reset-password.html?token=synthetic-private-token']){
  for(const headers of [{},{cookie:'pdl_session='+token}]){const {response,text}=await get(route,headers);assert.equal(response.status,200);assert.match(text,/name="robots" content="noindex, nofollow"/);assert(!text.includes(sentinel));assert(!text.includes('synthetic-private-token'));}
 }
 const privateApi=await get('/api/state');assert([401,404].includes(privateApi.response.status));assert(!privateApi.text.includes(sentinel));assert.equal(privateApi.response.headers.get('x-robots-tag'),'noindex, nofollow');
 const authedApi=await get('/api/state',{cookie:'pdl_session='+token});assert.equal(authedApi.response.status,200);assert(authedApi.text.includes(sentinel));assert.equal(authedApi.response.headers.get('x-robots-tag'),'noindex, nofollow');
 const badGuest=await get('/api/guest/'+'a'.repeat(48));assert.equal(badGuest.response.status,404);assert(!badGuest.text.includes(sentinel));assert.equal(badGuest.response.headers.get('x-robots-tag'),'noindex, nofollow');
 for(const route of ['/data/db.json','/data/platform.json','/.env','/server.js','/public-search-http.test.js','/Home','/unknown-search-page'])assert.equal((await get(route)).response.status,404);
 const upload=await get('/uploads/synthetic.txt');assert.equal(upload.response.status,307);assert.equal(upload.response.headers.get('location'),'/api/local-files/synthetic.txt');assert([401,404].includes((await get(upload.response.headers.get('location'))).response.status));
 const blog=await get('/blog.html?post=synthetic-slug');assert.equal(blog.response.status,200);assert(!blog.text.includes('rel="canonical"'),'query articles must not consolidate into listing');
 console.log('Integrated public search HTTP, authenticated isolation and token-route checks passed.');
}finally{await new Promise(resolve=>server.close(resolve));}})().catch(error=>{console.error(error);process.exitCode=1;});
