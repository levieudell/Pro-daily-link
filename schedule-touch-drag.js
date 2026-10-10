(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLScheduleTouchDrag=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Touch drag-and-drop for the schedule board. Desktop uses native HTML5 drag;
  // this module gives phones and tablets the same move-an-assignment gesture:
  // press and hold an assignment, drag it to a day cell, release to drop.
  const HOLD_MS=350;
  const MOVE_CANCEL_PX=12;
  const GHOST_OFFSET_Y=-56;

  function shouldStartDrag(elapsedMs,movePx){return elapsedMs>=HOLD_MS&&movePx<=MOVE_CANCEL_PX}

  function attach(root,options){
    const opts=options||{};
    const canManage=typeof opts.canManage==='function'?opts.canManage:()=>false;
    const onMove=typeof opts.onMove==='function'?opts.onMove:()=>{};
    let pending=null,dragging=false,ghost=null,currentCell=null,sourceBlock=null;

    const distance=(a,b)=>Math.max(Math.abs(a.clientX-b.clientX),Math.abs(a.clientY-b.clientY));

    function clearCellHighlight(){if(currentCell){currentCell.classList.remove('drag-over');currentCell=null}}
    function highlight(cell){if(cell===currentCell)return;clearCellHighlight();if(cell){cell.classList.add('drag-over');currentCell=cell}}

    function removeGhost(){if(ghost&&ghost.parentNode)ghost.parentNode.removeChild(ghost);ghost=null}
    function placeGhost(point){if(!ghost)return;ghost.style.left=point.clientX+'px';ghost.style.top=(point.clientY+GHOST_OFFSET_Y)+'px'}

    function reset(){
      pending=null;dragging=false;
      clearCellHighlight();
      removeGhost();
      if(sourceBlock){sourceBlock.classList.remove('dragging');sourceBlock=null}
      if(root.classList)root.classList.remove('schedule-touch-dragging');
    }

    function cellAt(point){
      const target=typeof root.elementFromPoint==='function'?root.elementFromPoint(point.clientX,point.clientY):null;
      const cell=target&&typeof target.closest==='function'?target.closest('[data-schedule-date]'):null;
      return cell;
    }

    function begin(start){
      dragging=true;
      sourceBlock=start.block;
      sourceBlock.classList.add('dragging');
      if(root.classList)root.classList.add('schedule-touch-dragging');
      ghost=sourceBlock.cloneNode(true);
      ghost.classList.add('schedule-touch-ghost');
      ghost.removeAttribute('data-assignment');
      ghost.removeAttribute('draggable');
      if(root.body&&root.body.appendChild)root.body.appendChild(ghost);
      placeGhost(start);
    }

    root.addEventListener('pointerdown',event=>{
      if(event.pointerType!=='touch'||!canManage())return;
      const block=typeof event.target.closest==='function'?event.target.closest('[data-assignment]'):null;
      if(!block)return;
      pending={pointerId:event.pointerId,block,start:{clientX:event.clientX,clientY:event.clientY},at:Date.now(),started:false};
    });

    root.addEventListener('pointermove',event=>{
      if(!pending||event.pointerId!==pending.pointerId)return;
      const movePx=distance(event,pending.start);
      if(!dragging){
        if(!shouldStartDrag(Date.now()-pending.at,movePx)){if(movePx>MOVE_CANCEL_PX)pending=null;return}
        pending.started=true;
        begin({block:pending.block,clientX:event.clientX,clientY:event.clientY});
      }
      event.preventDefault();
      placeGhost(event);
      highlight(cellAt(event));
    },{passive:false});

    root.addEventListener('pointerup',event=>{
      if(!pending||event.pointerId!==pending.pointerId)return;
      const wasDragging=dragging,dropped=currentCell;
      const payload=wasDragging&&dropped?{assignmentId:+pending.block.dataset.assignment,memberId:+pending.block.dataset.member,targetMemberId:+dropped.dataset.scheduleMember,date:dropped.dataset.scheduleDate}:null;
      if(payload)pending.block.dataset.touchDragged='1';
      reset();
      if(payload)onMove(payload);
    });

    root.addEventListener('pointercancel',event=>{if(pending&&event.pointerId===pending.pointerId)reset()});

    return {detach:reset,HOLD_MS,MOVE_CANCEL_PX};
  }

  return {HOLD_MS,MOVE_CANCEL_PX,shouldStartDrag,attach};
});
