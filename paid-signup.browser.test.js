'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');
let chromium;
for (const dependency of [
  'playwright',
  'playwright-core',
  process.env.PDL_PLAYWRIGHT_MODULE,
  path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')
].filter(Boolean)) {
  try { chromium = require(dependency).chromium; break; } catch { /* Try the next installed runtime. */ }
}
if (!chromium) throw new Error('Configure PDL_PLAYWRIGHT_MODULE with an available Playwright runtime.');

const root=__dirname;
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  let browser;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    browser=await chromium.launch({headless:true,...(process.env.PDL_BROWSER_PATH?{executablePath:process.env.PDL_BROWSER_PATH}:{})});
    for(const width of [390,1280]){
      const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
      let signups=0,checkouts=0;
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.hostname==='checkout.stripe.com')return route.fulfill({contentType:'text/html',body:'Synthetic secure checkout'});
        if(url.origin!==base)return route.abort();
        if(url.pathname==='/api/founder-offer')return route.fulfill({json:{enabled:false}});
        if(url.pathname==='/api/signup'){
          signups++;const input=route.request().postDataJSON();assert.equal(input.plan,'growth');assert.equal(input.billingCycle,'annual');assert.equal(input.legalAccepted,true);
          return route.fulfill({status:201,json:{company:{id:'synthetic-paid',founder:false,paymentRequired:true}}});
        }
        if(url.pathname==='/api/billing/checkout'){
          checkouts++;return checkouts===1?route.fulfill({status:503,json:{error:'Checkout is temporarily unavailable. Try again.'}}):route.fulfill({json:{url:'https://checkout.stripe.com/c/pay/synthetic'}});
        }
        return route.continue();
      });
      await page.goto(base+'/signup.html?plan=growth&cycle=annual');
      await page.getByRole('button',{name:'Decline',exact:true}).click();
      await page.locator('#company').fill('Test Builders');await page.locator('#owner').fill('Test Owner');
      await page.locator('#email').fill('owner@example.invalid');await page.locator('#password').fill('SyntheticPassword!42');
      await page.locator('[data-next="2"]').click();await page.locator('#trade').selectOption('Excavation');
      assert.ok(await page.locator('[name=plan][value=growth]').isChecked());
      fs.mkdirSync(path.join(root,'docs/paid-signup'),{recursive:true});
      await page.screenshot({path:path.join(root,`docs/paid-signup/plan-${width}.png`),fullPage:true});
      await page.locator('[data-next="3"]').click();
      assert.match(await page.locator('#payment-summary').innerText(),/Growth.*\$1,990 per year.*Charged today/);
      assert.doesNotMatch(await page.locator('body').innerText(),/14-day|after trial|no credit card|Nothing is charged today/i);
      await page.locator('#legal-acceptance').check();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const button=await page.locator('#create-company').evaluate(el=>({height:el.getBoundingClientRect().height,bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
      assert.ok(button.height>=48);assert.equal(button.bg,'rgb(255, 102, 0)');assert.equal(button.color,'rgb(0, 0, 0)');
      fs.mkdirSync(path.join(root,'docs/paid-signup'),{recursive:true});
      await page.screenshot({path:path.join(root,`docs/paid-signup/payment-${width}.png`),fullPage:true});
      await page.locator('#create-company').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('temporarily unavailable'));
      assert.equal(signups,1);assert.equal(await page.locator('#password').inputValue(),'');assert.ok(await page.locator('#assisted-setup').isDisabled());assert.ok(await page.locator('#checkout-resume').isVisible());
      await page.locator('#create-company').click();await page.waitForURL('https://checkout.stripe.com/**');
      assert.equal(signups,1,'retry does not create another account');assert.equal(checkouts,2);assert.deepEqual(errors,[]);
      await page.close();
    }
    for(const theme of ['light','dark']){
      const page=await browser.newPage({viewport:{width:390,height:844}});let stateReads=0;
      await page.addInitScript(theme=>localStorage.setItem('pdl-theme',theme),theme);
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!==base)return route.abort();
        if(url.pathname==='/api/config')return route.fulfill({json:{authRequired:true}});
        if(url.pathname==='/api/auth/me')return route.fulfill({json:{id:1,companyId:'unpaid-test',role:'owner',name:'Owner',emailVerifiedAt:'2026-11-03'}});
        if(url.pathname==='/api/account-access')return route.fulfill({json:{status:'Incomplete',locked:true,reason:'Complete payment to open your workspace.'}});
        if(url.pathname==='/api/billing')return route.fulfill({json:{status:'Incomplete',locked:true,plan:'growth',planName:'Growth',billingCycle:'annual',hasSubscription:false,configured:true,usage:{users:1,activeProjects:0},limits:{users:30,activeProjects:25},plans:[{id:'growth',name:'Growth',price:199,annualPrice:1990,available:true,annualAvailable:true,maxUsers:30,maxProjects:25}]}});
        if(url.pathname==='/api/state'){stateReads++;return route.fulfill({status:402,json:{error:'Payment required'}});}
        if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
        return route.continue();
      });
      await page.goto(base+'/index.html?billing=cancelled');
      await page.locator('#subscription-lock').waitFor({state:'visible'});
      assert.equal(await page.locator('.app-shell').isVisible(),false);assert.equal(stateReads,0);
      assert.equal(await page.locator('#subscription-lock-title').textContent(),'Finish your payment');
      const style=await page.locator('#subscription-lock-plan').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
      assert.deepEqual(style,{bg:'rgb(255, 102, 0)',color:'rgb(0, 0, 0)'});
      await page.screenshot({path:path.join(root,`docs/paid-signup/resume-${theme}-390.png`),fullPage:true});
      await page.locator('#subscription-lock-plan').click();await page.locator('#billing-modal').waitFor({state:'visible'});
      assert.ok(await page.locator('[data-billing-cycle=annual]').evaluate(el=>el.classList.contains('active')));
      assert.match(await page.locator('#billing-plans').innerText(),/1,?990/);
      await page.close();
    }
    console.log('Paid signup browser passed: selected price/cycle, upfront charge disclosure, brand, phone/desktop, checkout error and retry without duplicate account.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
