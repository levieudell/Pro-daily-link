'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const controller=require('./schedule-touch-drag'),source=fs.readFileSync('app.js','utf8');
function code(name){const lines=source.split('\n'),start=lines.findIndex(line=>line.startsWith(`function ${name}(`));assert.ok(start>=0,name);if(lines[start].trimEnd().endsWith('}'))return lines[start];const end=lines.findIndex((line,index)=>index>start&&line.trimEnd()==='}');return lines.slice(start,end+1).join('\n')}
function element(dataset={},privateText=''){
 const values=new Set(),node={dataset,privateText,style:{},children:[],parentNode:null,classList:{add:c=>values.add(c),remove:c=>values.delete(c),contains:c=>values.has(c)}};
 node.closest=selector=>selector==='[data-assignment]'&&dataset.assignment!==undefined||selector==='[data-schedule-date]'&&dataset.scheduleDate!==undefined?node:null;
 node.cloneNode=()=>element({...dataset},privateText);node.removeAttribute=name=>{if(name==='data-assignment')delete node.dataset.assignment};
 node.appendChild=child=>{child.parentNode=node;node.children.push(child)};node.removeChild=child=>{child.parentNode=null;node.children.splice(node.children.indexOf(child),1)};return node;
}
function setup(){
 const body=element(),block=element({assignment:'7',member:'1'},'Private synthetic project and work details'),cell=element({scheduleDate:'2026-10-11',scheduleMember:'2'}),events={},moves=[];
 const document={body,classList:element().classList,addEventListener(type,callback){(events[type]||=[]).push(callback)},querySelectorAll(){return []},querySelector(){return null},getElementById(){return null},elementFromPoint:()=>cell};
 const c={document,currentRole:'office',currentUser:{role:'project_manager',permissions:{scheduleCrews:true},effectiveCapabilities:{scheduling:{edit:true}}},window:{pdlWorkspaceActions:{enabled:()=>true}},draggedScheduleWork:{assignmentId:7,memberId:1},scheduleTouchDragController:null,notify(){}};
 vm.createContext(c);for(const name of ['canManageSchedule','canMoveScheduledWork','retireWorkspaceData'])vm.runInContext(code(name),c);
 c.scheduleTouchDragController=controller.attach(document,{canManage:c.canMoveScheduledWork,onMove:move=>moves.push(move)});
 const pointer=type=>{for(const fn of events[type]||[])fn({pointerId:1,pointerType:'touch',target:block,clientX:12,clientY:12,preventDefault(){},stopPropagation(){}})};
 return {c,body,block,cell,moves,pointer};
}
const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
try{
 for(const active of [false,true]){
  const t=setup();t.pointer('pointerdown');
  if(active){now+=controller.HOLD_MS+1;t.pointer('pointermove');assert.equal(t.body.children.length,1);assert.equal(t.body.children[0].privateText,'Private synthetic project and work details');assert.equal(t.block.classList.contains('dragging'),true)}
  t.c.retireWorkspaceData();assert.equal(t.c.currentUser,null);assert.equal(t.c.draggedScheduleWork,null);assert.equal(t.body.children.length,0,'private ghost removed from document.body');assert.equal(t.block.classList.contains('dragging'),false);assert.equal(t.cell.classList.contains('drag-over'),false);
  now+=controller.HOLD_MS+1;t.pointer('pointermove');t.pointer('pointerup');assert.equal(t.body.children.length,0,'a retired pending gesture cannot recreate a ghost');assert.equal(t.moves.length,0,'retired gesture cannot issue its drop callback');
 }
 assert.match(source,/scheduleTouchDragController=PDLScheduleTouchDrag\.attach\(document,/,'normal app must retain the actual controller reset handle');
 console.log('Touch scheduling retirement regression passed: actual controller clears pending/active private ghost, source/cell highlights and drop callback during workspace retirement.');
}finally{Date.now=originalNow}
