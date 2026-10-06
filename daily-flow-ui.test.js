'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {File}=require('node:buffer'),{indexedDB}=require('fake-indexeddb');
const {PhotoStore}=require('./daily-photo-store');
function storage(){const map=new Map();return{getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)}}
function element(){return {value:'',dataset:{},files:[],open:false,disabled:false,textContent:'',children:[],parentElement:{querySelector:()=>null,append(){}},addEventListener(){},close(){this.open=false},replaceChildren(){this.children=[]},append(...children){this.children.push(...children)}}}
const savedStorage=storage();
function context(){
 const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,element());return nodes.get(key)};
 class Transfer{constructor(){this.files=[];this.items={add:file=>this.files.push(file)}}}
 const ctx={$:node,$$:()=>[],window:{indexedDB},PDLDailyPhotoStore:{PhotoStore},crypto:require('node:crypto').webcrypto,File,DataTransfer:Transfer,document:{createElement:element},localStorage:savedStorage,projects:[{id:101}],company:{id:'fictional-tenant'},currentUser:{id:11,memberId:11},signedInCompanyId:()=>ctx.company.id,currentRole:'office',assignments:[],reports:[],photos:[],workdays:[{id:1,projectId:101,memberIds:[11],status:'active'}],preferredLanguage:'en',editingReportId:null,
  notify:message=>ctx.messages.push(message),messages:[],rememberActiveReport:()=>{},renderWorkdays:()=>ctx.events.push('render-clock'),renderMyDay:()=>{},renderReports:()=>{},showPage:()=>{},showReportMessage:message=>ctx.messages.push(message),events:[],
  encodeFiles:async files=>Array.from(files).map(file=>({name:file.name,type:file.type})),
  openEndDay:id=>{node('#end-day-id').value=id;node('#end-day-notes').value='';node('#end-day-next').value='';node('#end-day-modal').open=true},
  openReport:report=>{ctx.editingReportId=report.id;node('#report-modal').open=true;node('#field-notes').value=report.notes;node('#report-photos').files=[];node('#report-safety').value=report.safety;node('#report-project').value=0},
  saveDailyReport:async()=>{},openProjectPhoto:()=>{},openAssignment:()=>{},canManageSchedule:()=>true,loadRole:async()=>{},companyTodayIso:()=> '2026-10-06'};
 node('#ai-convert').onclick=async()=>{ctx.events.push('analyze');assert.equal(ctx.workdays[0].status,'complete','analysis must run after clock-out');node('#report-safety').value='Editable safety proposal';node('#report-next').value='AI next proposal';return true};
 node('#save-photos').onclick=async()=>{};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('daily-flow-ui.js','utf8'),ctx);return {ctx,node};
}
(async()=>{
 const first=context();first.ctx.openEndDay(1);first.node('#end-day-notes').value='Fictional work. Safety concern: opening.';first.node('#end-day-next').value='Bring guards';first.ctx.rememberEndDay();
 first.ctx.openEndDay(1);assert.equal(first.node('#end-day-notes').value,'Fictional work. Safety concern: opening.');assert.equal(first.node('#end-day-next').value,'Bring guards');
 first.ctx.openProjectPhoto(0,{workdayId:1});first.node('#photo-caption').value='Fictional incremental photo note';first.node('#photo-tags').value='progress';first.ctx.rememberProgressPhotoNotes();
 const file=new File(['synthetic bytes'],'fictional.jpg',{type:'image/jpeg',lastModified:1234}),input=first.node('#end-day-photos'),key=first.ctx.dailyPhotoKey('end',1);
 input.files=[file];await first.ctx.stageDailyPhotos(input,key);
 const refreshed=context();await refreshed.ctx.loadRole('office');await refreshed.ctx.restoreDailyPhotos(refreshed.node('#end-day-photos'),key);
 refreshed.ctx.openProjectPhoto(0,{workdayId:1});assert.equal(refreshed.node('#photo-caption').value,'Fictional incremental photo note');assert.equal(refreshed.node('#photo-tags').value,'progress');
 assert.equal(refreshed.node('#end-day-notes').value,'Fictional work. Safety concern: opening.');assert.equal(refreshed.node('#end-day-photos').files[0].name,'fictional.jpg');assert.equal(await refreshed.node('#end-day-photos').files[0].text(),'synthetic bytes');
 let calls=0;refreshed.ctx.api=async()=>{calls++;if(calls===1)throw Error('Synthetic lost response');return{workday:{id:1,projectId:101,memberIds:[11],status:'complete',reportId:10,endedAt:'2026-10-06T23:00:00Z'},report:{id:10,project:0,workdayId:1,status:'Draft',notes:'Fictional work. Safety concern: opening.',safety:'opening'}}};
 await refreshed.ctx.endDayWithRecovery();assert.equal(refreshed.ctx.workdays[0].status,'active');assert.ok(savedStorage.getItem(refreshed.ctx.dailyEndKey(1)),'unconfirmed end keeps recovery marker');
 await refreshed.ctx.endDayWithRecovery();assert.equal(refreshed.ctx.workdays[0].status,'complete');assert.equal(refreshed.ctx.reports.length,1);assert.equal(refreshed.node('#report-modal').open,true);assert.equal(refreshed.node('#report-photos').files.length,1);assert.equal(refreshed.node('#report-next').value,'Bring guards');assert.equal(refreshed.node('#report-safety').value,'Editable safety proposal');assert.deepEqual(refreshed.ctx.events,['render-clock','analyze']);
 assert.equal(savedStorage.getItem(refreshed.ctx.dailyEndKey(1)),null,'end marker clears only after files move durably to report');
 const reportKey=refreshed.ctx.dailyReportPhotoKey();assert.equal((await new PhotoStore(indexedDB).get(reportKey)).length,1,'review photos survive another refresh before upload');
 console.log('Daily flow UI passed: notes survive reopen, photo bytes survive refresh, failed clock-out confirmation retains recovery, clock updates before analysis, editable safety/next review and durable photo transfer.');
})().catch(error=>{console.error(error);process.exitCode=1});
