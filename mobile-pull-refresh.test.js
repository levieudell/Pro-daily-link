'use strict';
// Synthetic touch events against the production handler; no browser, network,
// credentials or customer data. Layout and real iPhone QA remain separate.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
function harness({standalone=true}={}){
  const listeners={},classes=new Set(),label={},icon={},indicator={classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),toggle:(n,on)=>on?classes.add(n):classes.delete(n)},style:{},setAttribute(){},querySelector:s=>s==='b'?label:icon};
  const state={reloads:0,dialogOpen:false,draft:'Unsaved synthetic project note',listeners,classes,indicator,window:{scrollY:0,ontouchstart:null},navigator:{standalone:false},matchMedia:()=>({matches:standalone}),location:{reload(){state.reloads++}},document:{createElement:()=>indicator,body:{append(){}},querySelector:s=>s==='dialog[open]'&&state.dialogOpen?{}:null,addEventListener:(type,fn)=>{listeners[type]=fn}}};
  const start=source.indexOf('function enableHomeScreenPullRefresh('),end=source.indexOf('\nenableHomeScreenPullRefresh();',start);
  vm.createContext(state);vm.runInContext(source.slice(start,end)+'\nenableHomeScreenPullRefresh();',state);
  state.touch=(type,y=0,{count=1,inDialog=false,editable=false}={})=>listeners[type]?.({target:{closest:selector=>selector==='dialog'?inDialog?{}:null:editable?{}:null},touches:Array.from({length:count},()=>({clientY:y}))});
  state.pull=(options={})=>{state.touch('touchstart',100,options);state.touch('touchmove',210,options);state.touch('touchend',210,options)};
  return state;
}
let h=harness();h.dialogOpen=true;h.pull({inDialog:true});
assert.equal(h.reloads,0,'downward swipe inside project details must not reload and close it');
assert.equal(h.draft,'Unsaved synthetic project note');assert.equal(h.classes.has('visible'),false);
// All open dialogs protect their work, even a touch on the backdrop.
h.pull();assert.equal(h.reloads,0);
h.dialogOpen=false;h.pull();assert.equal(h.reloads,1,'normal home-screen pull refresh remains available');
h=harness();h.touch('touchstart',100);h.touch('touchmove',210);h.touch('touchcancel');h.touch('touchend');
assert.equal(h.reloads,0,'interrupted touch must not refresh');assert.equal(h.classes.has('visible'),false);
h.pull();assert.equal(h.reloads,1,'a new gesture works after cancellation');
h=harness();h.touch('touchstart',100);h.touch('touchmove',210,{count:2});h.touch('touchend');assert.equal(h.reloads,0,'multi-touch interrupts tracking');h.pull();assert.equal(h.reloads,1);
h=harness();h.touch('touchstart',100);h.touch('touchmove',210);h.dialogOpen=true;h.touch('touchend');assert.equal(h.reloads,0,'a dialog opening during a gesture protects its work');
h.dialogOpen=false;h.pull();assert.equal(h.reloads,1);
h=harness();h.touch('touchstart',100);h.window.scrollY=40;h.touch('touchmove',210);h.touch('touchend');assert.equal(h.reloads,0,'page leaving the top interrupts refresh');
h=harness();h.pull({editable:true});assert.equal(h.reloads,0,'input and editable gestures protect unsaved work');
h=harness();h.window.scrollY=20;h.pull();assert.equal(h.reloads,0);h.window.scrollY=0;h.touch('touchstart',100);h.touch('touchmove',150);h.touch('touchend');assert.equal(h.reloads,0,'short gesture does not reload');
h=harness({standalone:false});assert.equal(Object.keys(h.listeners).length,0,'ordinary browser does not install home-screen refresh');
console.log('Mobile pull refresh behavior passed: open dialogs/drafts, interrupted/repeated gestures, multi-touch, mid-gesture modal, editable fields, normal refresh and browser mode. Synthetic events; real iPhone QA pending.');

