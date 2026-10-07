'use strict';
const assert=require('node:assert/strict'),{propose,normalize,reviewSuggestions,groundReviewSuggestions,scopeProposal}=require('./daily-work-extraction');
const floor=[{id:'line-floor',name:'FLOORING',unit:'SF'}];
const classify=(description,items=floor)=>scopeProposal({description,needsScopeConfirmation:true},items);
for(const text of ['Installed bathroom wall tile.','Added three tiles to the bathroom wall.','We tiled the bathroom walls.','We were tiling the bathroom wall.']){
  assert.equal(classify(text).mode,'custom',text);
  assert.equal(propose(text).length,1,text+' remains visible without a provider');
}
for(const text of ['Installed bathroom floor tile.','We tiled the bathroom floor.','Started flooring on the stairs.','Installed the bathroom floor.']){
  const result=classify(text);assert.equal(result.mode,'estimate',text);assert.equal(result.estimateItemId,'line-floor');
}
for(const text of ['Added three bathroom tiles.','Started on the stairs.','Worked on the bathroom.','Installed bathroom wall and floor tile.','Installed tile flooring and trim.','Cleaned the bathroom floor and installed floor tile.'])assert.equal(classify(text).mode,'review',text);
assert.equal(classify('Cleaned the bathroom floor.').mode,'custom');
assert.equal(classify('Measured the main floor.').mode,'custom');
assert.equal(classify('Installed bathroom floor tile.',[{id:1,name:'Bathroom LVP flooring'}]).mode,'custom','Tile is not LVP');
assert.equal(classify('Installed bathroom floor tile.',[{id:1,name:'Kitchen tile flooring'}]).mode,'custom','Explicit room mismatch');
assert.equal(classify('Installed upstairs LVP flooring.',[{id:1,name:'Main floor LVP flooring'}]).mode,'custom','Upper versus main floor mismatch');
assert.equal(classify('Installed second floor LVP flooring.',[{id:1,name:'First floor LVP flooring'}]).mode,'custom');
assert.equal(classify('Installed upstairs LVP flooring.',[{id:1,name:'Second floor LVP flooring'}]).mode,'review','Upstairs is not a specific numbered floor');
assert.equal(classify('Installed tile flooring.',[{id:1,name:'Bathroom tile flooring'}]).mode,'review','Unstated room');
assert.equal(classify('Installed floor tile.',[{id:1,name:'FLOORING'},{id:2,name:'Floor tile'}]).mode,'review','Multiple plausible lines');
assert.equal(classify('Installed bathroom floor tile.',[{id:1,name:'Kitchen tile flooring'},{id:2,name:'Bathroom tile flooring'}]).estimateItemId,2);
assert.equal(classify('Installed bathroom wall tile.',[{id:1,name:'Tile work'}]).mode,'review','Generic tile may cover walls');
assert.equal(classify('Installed bathroom wall tile.',[{id:1,name:'Miscellaneous allowance'}]).mode,'review','Unknown estimate scope');
const note='Installed three tiles on the bathroom wall.';
const renamed=normalize([{description:'FLOORING',evidence:note,quantity:999,laborHours:0}],note)[0];
assert.equal(renamed.scopeEvidence,note);assert.equal(renamed.scopeUnverified,false);assert.equal(renamed.quantity,3);assert.equal(scopeProposal(renamed,floor).mode,'custom');
const ambiguous=normalize([{description:'Installed bathroom floor tile.',evidence:'installed tile'}],'Installed bathroom wall tile. Installed kitchen floor tile.')[0];
assert.equal(ambiguous.scopeUnverified,true);assert.equal(scopeProposal(ambiguous,floor).mode,'review');
const ungrounded=normalize([{description:'Installed bathroom floor tile.',evidence:'invented activity'}],note)[0];assert.equal(scopeProposal(ungrounded,floor).mode,'review');
const duplicates=normalize([{description:'Wall A',evidence:note},{description:'Wall B',evidence:note}],note);assert(duplicates.every(row=>row.quantity===null&&row.scopeEvidence===note&&scopeProposal(row,floor).mode==='custom'));
const persisted=reviewSuggestions([renamed,{...ungrounded,scopeChoice:'review'}]);assert.equal(persisted[0].scopeEvidence,note);assert.equal(scopeProposal(persisted[0],floor).mode,'custom');assert.equal(scopeProposal(persisted[1],floor).mode,'review');
assert.equal(scopeProposal({...renamed,estimateItemId:'line-floor'},floor).mode,'estimate','Explicit saved selection is authoritative');
assert.equal(scopeProposal({...renamed,custom:true},floor).mode,'custom');
assert.equal(scopeProposal({...renamed,scopeChoice:'review'},floor).mode,'review','Manual estimate override survives reopening');
const legacy=groundReviewSuggestions([{description:'FLOORING',quantity:7,unit:'SF',laborHours:2,needsScopeConfirmation:true}],'We tiled the bathroom walls.')[0];assert.equal(scopeProposal(legacy,floor).mode,'review');assert.equal(legacy.quantity,7);assert.equal(legacy.laborHours,2);
const savedChoice={description:'FLOORING',estimateItemId:'line-floor',needsScopeConfirmation:true};assert.deepEqual(groundReviewSuggestions([savedChoice],'We tiled the bathroom walls.'),[savedChoice]);
assert.equal(scopeProposal(groundReviewSuggestions(propose('We tiled the bathroom walls.'),'We tiled the bathroom walls.')[0],floor).mode,'custom');
assert.equal(classify('Installed bathroom wall tile.',[]).mode,'custom');
assert.equal(classify('Installed bathroom floor tile.').laborHours,undefined,'Scope matching has no labor calculation');
console.log('Daily work scope: wall/floor/activity/material/location ambiguity, grounded provider rename, saved selections and bounded metadata passed.');
