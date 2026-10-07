'use strict';
// Actual integrated handlers, synthetic IndexedDB/File bytes; no provider calls.
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
const progressCore=source.split('\n').find(line=>line.startsWith("$('#save-photos').onclick="));
const laborGuard=source.split('\n').find(line=>line.startsWith('saveDailyReport=async function(status){const laborSaveScope='));
const uploader=source.split('\n').find(line=>line.startsWith('async function uploadPhotos('));
let harness=fs.readFileSync(__dirname+'/daily-flow-ui.test.js','utf8').split('(async()=>{')[0];
harness=harness.replace('Object.assign(ctx,overrides);vm.createContext(ctx);', 'Object.assign(ctx,overrides);vm.createContext(ctx);vm.runInContext(overrides.preSaveSource||progressCore,ctx);');
const cases=`
async function tickUntil(predicate){for(let i=0;i<30&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert(predicate(),'fixture reached awaited handler');}
async function stage(test,selector,key,bytes){const input=test.node(selector);input.files=[new File([bytes],'synthetic-recovery.jpg',{type:'image/jpeg'})];await test.ctx.stageDailyPhotos(input,key);return input;}
(async()=>{
  // The actual labor guard aborts after close while the outer photo wrapper waits.
  let release,writes=0;const pending=new Promise(resolve=>release=resolve);
  const test=context({preSaveSource:laborGuard,timeCardsOn:()=>true,reportLaborLoadedKey:'old',reportLaborSelectionKey:()=> 'current',reportLaborLookupPromise:pending,noteLaborUnassigned:()=>0,saveDailyReportBeforeLaborGuard:async()=>{writes++}});
  test.node('#report-modal').open=true;test.node('#report-project').value=0;test.node('#report-date').value='2026-10-12';
  const key=test.ctx.dailyReportPhotoKey();await stage(test,'#report-photos',key,'Exact daily retry bytes');
  const save=test.ctx.saveDailyReport('Draft');await new Promise(resolve=>setImmediate(resolve));test.node('#report-modal').close();release();await save;
  assert.equal(writes,0);assert.equal(await (await new PhotoStore(indexedDB).get(key))[0].file.text(),'Exact daily retry bytes');

  // The actual progress core catches an upload failure after dialog closure.
  let reject,attempts=0;const upload=new Promise((_,no)=>reject=no);
  const progress=context({uploadPhotos:()=>{attempts++;return upload},photoTags:()=>[],renderProjectCards:()=>{},openProject:()=>{}});
  progress.ctx.openProjectPhoto(0);progress.node('#photo-modal').open=true;progress.node('#photo-project').value=0;
  const photoKey=progress.node('#office-photos').dataset.recoveryKey;await stage(progress,'#office-photos',photoKey,'Exact progress retry bytes');
  progress.node('#photo-caption').value='Exact progress retry notes';
  const saving=progress.node('#save-photos').onclick();await tickUntil(()=>attempts===1);progress.node('#photo-modal').close();reject(Error('Synthetic lost upload'));await saving;
  assert.equal(progress.ctx.photos.length,0);assert.equal(await (await new PhotoStore(indexedDB).get(photoKey))[0].file.text(),'Exact progress retry bytes');
  assert.match(savedStorage.getItem(progress.ctx.progressPhotoNotesKey(photoKey)),/Exact progress retry notes/);

  // Closing, reopening, or changing identity during preparation never delegates.
  for(const change of ['close','reopen','user','tenant']){
    let calls=0;const stale=context({uploadPhotos:async()=>{calls++;return []},photoTags:()=>[],renderProjectCards:()=>{},openProject:()=>{}});
    stale.ctx.company={id:'synthetic-preparation-'+change};stale.ctx.openProjectPhoto(0);stale.node('#photo-modal').open=true;const input=stale.node('#office-photos'),oldKey=input.dataset.recoveryKey;
    await stage(stale,'#office-photos',oldKey,'Retained '+change);
    vm.runInContext('dailyPhotoRestores.set($("#office-photos").dataset.recoveryKey,new Promise(resolve=>{globalThis.releaseRestore=resolve}))',stale.ctx);
    const preparing=stale.node('#save-photos').onclick();
    if(change==='close')stale.node('#photo-modal').close();
    if(change==='reopen'){stale.node('#photo-modal').close();stale.node('#photo-modal').open=true;input.dataset.recoveryGeneration=String(Number(input.dataset.recoveryGeneration)+1);}
    if(change==='user')stale.ctx.currentUser={id:99};
    if(change==='tenant')stale.ctx.company={id:'other-synthetic-tenant'};
    stale.ctx.releaseRestore();await preparing;assert.equal(calls,0,change+' during preparation cannot save');assert.equal((await new PhotoStore(indexedDB).get(oldKey)).length,1);
  }
  // Closing during FileReader preparation aborts before the real upload API call.
  let encoded,apiCalls=0;const encoding=new Promise(resolve=>encoded=resolve),uploadCtx={projects:[{id:101}],navigator:{onLine:true},preferredLanguage:'en',notify:()=>{},encodeFiles:()=>encoding,photoTags:()=>[],api:()=>{apiCalls++;return []},$:()=>({value:''})};
  vm.createContext(uploadCtx);vm.runInContext(uploader,uploadCtx);let current=true;
  const sending=uploadCtx.uploadPhotos({files:[{}],project:0,isCurrent:()=>current});current=false;encoded([{}]);await assert.rejects(sending,/photo form changed/);assert.equal(apiCalls,0);
  // A confirmed actual progress core save clears bytes and notes exactly once.
  const confirmed=context({uploadPhotos:async()=>[{id:7}],photoTags:()=>[],renderProjectCards:()=>{},openProject:()=>{}});
  confirmed.ctx.company={id:'synthetic-confirmed-progress'};confirmed.ctx.openProjectPhoto(0);confirmed.node('#photo-modal').open=true;confirmed.node('#photo-project').value=0;
  const confirmedKey=confirmed.node('#office-photos').dataset.recoveryKey;await stage(confirmed,'#office-photos',confirmedKey,'Confirmed progress bytes');
  await confirmed.node('#save-photos').onclick();assert.equal(confirmed.ctx.photos.length,1);assert.equal((await new PhotoStore(indexedDB).get(confirmedKey)).length,0);assert.equal(savedStorage.getItem(confirmed.ctx.progressPhotoNotesKey(confirmedKey)),null);
  console.log('Integrated photo recovery: cancelled labor/encoding/preparation and failed closed progress uploads retain exact bytes/notes; confirmed save alone clears recovery.');
})().catch(error=>{console.error(error);process.exitCode=1});`;
new Function('require','progressCore','laborGuard','uploader',harness+cases)(require,progressCore,laborGuard,uploader);
