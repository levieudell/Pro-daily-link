'use strict';
// Full app smoke test. The demo runner creates disposable data and disables all providers.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
let chromium;
for(const dependency of ['playwright',process.env.PDL_PLAYWRIGHT_MODULE,path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)){
 try{chromium=require(dependency).chromium;break}catch{}
}
if(!chromium)throw Error('Configure PDL_PLAYWRIGHT_MODULE with an available Playwright runtime.');
const browserPath=process.env.PDL_BROWSER_PATH||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>fs.existsSync(file));
fs.mkdirSync(path.join(__dirname,'output'),{recursive:true});
(async()=>{let child,browser;try{
 child=spawn(process.execPath,['scripts/safety-demo.cjs','--port=0'],{cwd:__dirname,stdio:['ignore','pipe','pipe']});let log='';
 await new Promise((resolve,reject)=>{let timer=setTimeout(()=>reject(Error('Demo startup timed out')),15000);child.stdout.on('data',c=>{log+=c;if(log.includes('Temporary demo password:')){clearTimeout(timer);resolve()}});child.stderr.on('data',c=>log+=c);child.on('exit',c=>reject(Error('Demo exited '+c)))});
 const url=log.match(/Safety demo: (http[^\s]+)/)[1],password=log.match(/Temporary demo password: ([^\s]+)/)[1];
 browser=await chromium.launch({headless:true,executablePath:browserPath});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith(new URL(url).origin)?route.continue():route.abort());
 await page.goto(url);await page.locator('#email').fill('pm@example.invalid');await page.locator('#password').fill(password);await page.locator('#login button[type=submit]').click();
 await page.waitForURL('**/app?**',{timeout:20000});await page.locator('#open-safety-pm').click();
 const dialog=page.locator('#safety-pm-dialog');await dialog.waitFor({state:'visible'});await dialog.locator('[data-safety-generate]').click();
 await dialog.locator('.safety-check').first().waitFor();
 await page.screenshot({path:path.join(__dirname,'output/safety-mvp-integrated-desktop.png'),animations:'disabled'});
 await dialog.locator('[data-safety-close]').click();
 await page.locator('[data-open-report]').first().click();await page.locator('#report-open-safety').click();await dialog.waitFor({state:'visible'});await dialog.locator('.safety-check').first().waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(__dirname,'output/safety-mvp-integrated-mobile.png'),animations:'disabled'});
 if(errors.length)throw Error('App browser errors: '+errors.join('; '));console.log('Integrated real app login, Safety navigation, generation and mobile passed.');
}finally{if(browser)await browser.close();if(child)child.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
