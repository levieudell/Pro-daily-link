'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parse}=require('parse5');
const {articleMetadata,renderArticleHead}=require('./public-blog-metadata');
const {entries,generate}=require('./scripts/generate-public-sitemap');
const {isPublicFile}=require('./public-file-policy');
function nodes(node,predicate){return [...(predicate(node)?[node]:[]),...(node.childNodes||[]).flatMap(child=>nodes(child,predicate))]}
function attribute(node,key){return (node.attrs||[]).find(row=>row.name===key)?.value}
function text(node){return node.value||node.childNodes?.map(text).join('')||''}
const pages=['landing.html','about.html','blog.html','signup.html','login.html','forgot-password.html','index.html','terms.html','privacy.html'];
const privatePages=['signup.html','login.html','forgot-password.html','index.html'];
for(const file of pages){
  const source=fs.readFileSync(path.join(__dirname,file),'utf8'),doc=parse(source),title=text(nodes(doc,n=>n.tagName==='title')[0]);
  assert.ok(title.length>=30&&title.length<=60,`${file} title length ${title.length}`);
  const metas=nodes(doc,n=>n.tagName==='meta'),description=attribute(metas.find(n=>attribute(n,'name')==='description'),'content');
  assert.ok(description.length>=110&&description.length<=160,`${file} description length ${description.length}`);
  for(const [key,value] of [['og:title',title],['og:description',description],['og:image:width','1200'],['og:image:height','630']])assert.equal(attribute(metas.find(n=>attribute(n,'property')===key),'content'),value);
  assert.equal(attribute(metas.find(n=>attribute(n,'name')==='twitter:card'),'content'),'summary_large_image');
  const canonical=nodes(doc,n=>n.tagName==='link'&&attribute(n,'rel')==='canonical');assert.equal(canonical.length,1);assert.match(attribute(canonical[0],'href'),/^https:\/\/app\.prodailylink\.com\//);
  if(privatePages.includes(file))assert.equal(attribute(metas.find(n=>attribute(n,'name')==='robots'),'content'),'noindex, nofollow');
  const schemas=nodes(doc,n=>n.tagName==='script'&&attribute(n,'type')==='application/ld+json').map(n=>JSON.parse(text(n)));
  const organizations=schemas.filter(n=>n['@type']==='Organization');assert.equal(organizations.length,1);assert.equal(organizations[0].url,'https://app.prodailylink.com/');assert.ok(!organizations[0].sameAs,'Unverified company profiles must not be published');
  if(file!=='index.html')for(const img of nodes(doc,n=>n.tagName==='img'&&attribute(n,'src')==='assets/pro-daily-link-logo.png')){assert.equal(attribute(img,'width'),'482');assert.equal(attribute(img,'height'),'496');assert.equal(img.parentNode.tagName,'picture');assert.equal(attribute(img.parentNode.childNodes.find(n=>n.tagName==='source'),'type'),'image/webp')}
  assert.doesNotMatch(source,/\/landing\.html#/);
}
const landing=parse(fs.readFileSync(path.join(__dirname,'landing.html'),'utf8')),headings=nodes(landing,n=>/^h[1-6]$/.test(n.tagName||''));let previous=0;for(const h of headings){const level=Number(h.tagName[1]);assert.ok(level<=previous+1,`Skipped heading level before ${text(h)}`);previous=level}assert.equal(text(headings[0]),'Daily reports and production tracking');
const post={title:'Daily reports that crews can use',slug:'daily-reports',excerpt:'A practical note about field records.',author:'Actual Author',publishedAt:'2026-09-20T09:00:00Z',updatedAt:'2026-10-01T12:00:00Z'};
const metadata=articleMetadata(post);assert.equal(metadata.schema.author.name,post.author);assert.equal(metadata.schema.datePublished,'2026-09-20T09:00:00.000Z');assert.equal(metadata.schema.dateModified,'2026-10-01T12:00:00.000Z');assert.equal(metadata.canonical,'https://app.prodailylink.com/blog.html?post=daily-reports');
const missing=articleMetadata({...post,author:'',publishedAt:null,updatedAt:'invalid'});assert.ok(!missing.schema.author&&!missing.schema.datePublished&&!missing.schema.dateModified);
const longTitle='A'.repeat(160);assert.equal(articleMetadata({...post,title:longTitle}).title,longTitle+' · Pro Daily Link');assert.equal(articleMetadata({...post,title:longTitle}).titleNeedsReview,true);
const malicious={...post,title:'</title><script>alert(1)</script>',excerpt:'" onload="alert(1)',author:'</script><script>alert(2)</script>'};
const rendered=renderArticleHead(fs.readFileSync(path.join(__dirname,'blog.html'),'utf8'),malicious),renderedDoc=parse(rendered);assert.equal(text(nodes(renderedDoc,n=>n.tagName==='title')[0]),malicious.title+' · Pro Daily Link');assert.doesNotMatch(rendered,/<script>alert\(/);JSON.parse(text(nodes(renderedDoc,n=>attribute(n,'id')==='page-schema')[0]));
const dollarTitle="Budget $& $' $` $$ review";assert.equal(text(nodes(parse(renderArticleHead(fs.readFileSync(path.join(__dirname,'blog.html'),'utf8'),{...post,title:dollarTitle})),n=>n.tagName==='title')[0]),dollarTitle+' · Pro Daily Link');
assert.deepEqual(entries.map(([url])=>url),['/','/about.html','/blog.html','/vs/raken.html','/vs/procore.html','/vs/paper-daily-logs.html','/terms.html','/privacy.html']);assert.match(generate(()=> '2026-09-17'),/<lastmod>2026-09-17<\/lastmod>/);assert.throws(()=>generate(()=>''));
for(const file of ['assets/pro-daily-link-logo.webp','public-blog-metadata.js','robots.txt','sitemap.xml'])assert.equal(isPublicFile(__dirname,path.join(__dirname,file)),true);
for(const file of ['public-audit.test.js','scripts/generate-public-sitemap.js','data/platform.json','.env','uploads/company-logos/private.png'])assert.equal(isPublicFile(__dirname,path.join(__dirname,file)),false);

// Fixture-only HTTP checks; mock the existing SDK so no audit test can emit telemetry.
const sdkPath=require.resolve('@heycatch/sdk');require.cache[sdkPath]={id:sdkPath,filename:sdkPath,loaded:true,exports:{analytics:{init(){},setIdentity(){},trackEvent(){}}}};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-public-audit-'));
process.env.PDL_DB_FILE=path.join(temp,'db.json');process.env.PDL_PLATFORM_FILE=path.join(temp,'platform.json');process.env.PDL_SUPABASE_ENABLED='0';process.env.PDL_REQUIRE_AUTH='1';process.env.PDL_WEEKLY_DIGEST='0';
for(const key of ['SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','OPENAI_API_KEY','DATABASE_URL','PDL_DATABASE_URL'])delete process.env[key];
fs.copyFileSync(path.join(__dirname,'data/db.json'),process.env.PDL_DB_FILE);
fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],sessions:[],blogPosts:[{...post,id:1,status:'Published'},{...post,id:2,slug:'private-draft',status:'Draft'}]}));
const platformBefore=fs.readFileSync(process.env.PDL_PLATFORM_FILE,'utf8');
const {loadPublishedPost}=require('./public-blog-source');assert.equal(loadPublishedPost(process.env.PDL_PLATFORM_FILE,'daily-reports').id,1);assert.equal(loadPublishedPost(process.env.PDL_PLATFORM_FILE,'private-draft'),null);assert.equal(loadPublishedPost(process.env.PDL_PLATFORM_FILE,'../daily-reports'),null);assert.equal(loadPublishedPost(path.join(temp,'missing.json'),'daily-reports'),null);
const {server}=require('./server');
(async()=>{try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const redirect=await fetch(base+'/landing.html?plan=growth',{redirect:'manual'});assert.equal(redirect.status,301);assert.equal(redirect.headers.get('location'),'/?plan=growth');
  const head=await fetch(base+'/landing.html',{method:'HEAD',redirect:'manual'});assert.equal(head.status,301);assert.equal(await head.text(),'');
  for(const route of ['/robots.txt','/sitemap.xml','/assets/pro-daily-link-logo.webp','/public-blog-metadata.js'])assert.equal((await fetch(base+route)).status,200,route);
  assert.match(await(await fetch(base+'/robots.txt')).text(),/Disallow: \/app[\s\S]*Disallow: \/api\/[\s\S]*Disallow: \/guest\/[\s\S]*Sitemap: https:\/\/app.prodailylink.com\/sitemap.xml/);
  const article=await fetch(base+'/blog.html?post=daily-reports');assert.equal(article.status,200);const html=await article.text();assert.match(html,/"@type":"BlogPosting"/);assert.match(html,/rel="canonical" href="https:\/\/app.prodailylink.com\/blog.html\?post=daily-reports"/);
  for(const slug of ['private-draft','unknown','%3Cscript%3E']){const response=await fetch(base+'/blog.html?post='+slug);assert.equal(response.status,404);assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');assert.doesNotMatch(await response.text(),/Actual Author|Daily reports that crews/)}
  for(const route of ['/data/platform.json','/scripts/generate-public-sitemap.js','/public-audit.test.js'])assert.equal((await fetch(base+route)).status,404);
  assert.equal((await fetch(base+'/public-blog-source.js')).status,404);
  assert.equal(fs.readFileSync(process.env.PDL_PLATFORM_FILE,'utf8'),platformBefore,'Article metadata must not seed support items or persist any platform records');
  console.log('Public audit metadata, privacy, article injection, redirect, discovery and synthetic HTTP regressions passed.');
}catch(error){console.error(error);process.exitCode=1}finally{await new Promise(resolve=>server.close(resolve));}})();
