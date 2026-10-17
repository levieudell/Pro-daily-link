'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8'),source=app.slice(app.indexOf('const endingWorkdays='),app.indexOf('\nlet endDayVoice='));
function harness(){
 const elements={'#report-modal':{open:false,addEventListener(type,fn){this.onclose=fn}},'#field-notes':{value:'Unsaved notes'},'#report-project':{value:'0'},'#report-date':{value:'2026-10-17'}};
 const storage=new Map(),events=[],files=[{name:'unsent-photo.jpg'}];let calls=0,release,fail=null;
 const result={workday:{id:1,projectId:101,status:'complete',endedAt:'2026-10-17T17:00:00Z'},report:{id:9,project:0,dateIso:'2026-10-17',notes:'',updatedAt:'new'},timeCards:[{id:4,workdayId:1,outAt:'2026-10-17T17:00:00Z'}],previousReportUpdatedAt:'old'};
 const context={workdays:[{id:1,projectId:101,status:'active'}],reports:[],timeCards:[],preferredLanguage:'en',editingReportId:null,editingReportUpdatedAt:'',console,setTimeout,JSON,Number,Set,Error,
  $:key=>elements[key],$$:()=>[{dataset:{endWorkday:'1'},disabled:false}],adoptReport:x=>x,api:async()=>{calls++;await new Promise(resolve=>release=resolve);if(fail)throw fail;return result},
  readOfflineDraft:key=>JSON.parse(storage.get(String(key))||'{"notes":""}'),hasOfflineReportContent:x=>Boolean(x.notes),offlineReportStorageKey:String,
  localStorage:{setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(String(key))},offlineReportDraftKey:()=>`report-${context.editingReportId}`,
  rememberActiveReport:()=>events.push('recover'),writeOfflineDraft:()=>events.push('draft'),renderWorkdays:()=>events.push('clock'),renderMyDay:()=>events.push('myday'),renderReports:()=>events.push('reports'),showPage:()=>events.push('page'),openReport:report=>{elements['#report-modal'].open=true;events.push(['open',report.id])},notify:message=>events.push(message),window:{applyLiveLabor:()=>events.push('labor')},};
 vm.createContext(context);vm.runInContext(source,context);
 return {context,elements,storage,events,files,result,calls:()=>calls,finish:()=>release(),fail:error=>fail=error};
}
(async()=>{
 let h=harness(),pending=h.context.openEndDay(1);await h.context.openEndDay(1);assert.equal(h.calls(),1,'double tap only sends one request');h.finish();await pending;
 assert.equal(h.context.workdays[0].endedAt,h.result.workday.endedAt);assert(h.events.some(x=>Array.isArray(x)&&x[0]==='open'&&x[1]===9));assert.equal(h.context.timeCards[0].outAt,h.result.workday.endedAt);assert(!source.includes('ai-convert'),'clock-out never invokes AI');
 h=harness();h.fail(new Error('Network failed'));pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.context.workdays[0].status,'active');assert(!h.events.some(Array.isArray));h.fail(null);pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.calls(),2,'failure unlocks safe retry');
 h=harness();h.fail({queued:true,message:'Queued'});pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.context.workdays[0].status,'active');assert(h.events.some(x=>typeof x==='string'&&x.includes('connection returns')));
 h=harness();h.elements['#report-modal'].open=true;h.context.editingReportId=9;h.context.editingReportUpdatedAt='old';h.elements['#report-photos']={files:h.files};pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.elements['#field-notes'].value,'Unsaved notes');assert.equal(h.elements['#report-photos'].files,h.files);assert.equal(h.context.editingReportUpdatedAt,'new');assert(!h.events.some(Array.isArray));
 h=harness();h.elements['#report-modal'].open=true;h.context.editingReportId=9;h.context.editingReportUpdatedAt='stale';pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.context.editingReportUpdatedAt,'stale','external edits retain stale revision protection');
 h=harness();h.elements['#report-modal'].open=true;h.context.editingReportId=8;h.elements['#report-photos']={files:h.files};pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(h.elements['#report-photos'].files,h.files);assert(!h.events.some(Array.isArray),'a different open form stays intact');assert.equal(typeof h.elements['#report-modal'].onclose,'function');
 h=harness();h.storage.set('0',JSON.stringify({notes:'Recovered project draft',dateIso:'2026-10-17'}));pending=h.context.openEndDay(1);h.finish();await pending;assert.equal(JSON.parse(h.storage.get('report-9')).notes,'Recovered project draft');assert(!h.storage.has('0'));
 // Replay uses the existing queue and signals the direct report opener only after confirmation.
 const queued=[{method:'POST',path:'/api/workdays/1/end',body:'{}',signature:'test',tag:'test'}],store=new Map([['pdl-offline-queue',JSON.stringify(queued)]]),synced=[];
 const offline={navigator:{onLine:true},document:{readyState:'loading',addEventListener(){}},localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)},window:{addEventListener(){},dispatchEvent:event=>synced.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},fetch:async()=>({ok:true,status:200,json:async()=>h.result}),loadRole:async()=>synced.push('refreshed'),currentRole:'field',notify(){},console};
 vm.createContext(offline);vm.runInContext(fs.readFileSync('offline.js','utf8'),offline);await offline.window.PDLOffline.drain();assert.equal(offline.window.PDLOffline.queuedCount(),0);assert.equal(synced[0],'refreshed');assert.equal(synced[1].type,'pdl-clockout-synced');assert.equal(synced[1].detail.workdayId,1);
 console.log('Direct clock-out UI: double taps, failed/queued requests, retry, report opening, photo/note preservation, recovery migration, stale revision and offline replay passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
