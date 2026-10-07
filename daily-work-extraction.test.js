'use strict';
const assert=require('node:assert/strict'),{propose,normalize,reviewSuggestions}=require('./daily-work-extraction');
const notes='started on the stairs, added three more tiles to the bathroom, cleaned the upstairs and sweeper the main big bedroom up there and measured the trim for the main floor';
const rows=propose(notes);assert.equal(rows.length,5);assert.deepEqual(rows.map(row=>row.quantity),[null,3,null,null,null]);assert.deepEqual(rows.map(row=>row.unit),['','EA','','','']);assert(rows.every(row=>row.laborHours===0&&row.needsScopeConfirmation&&row.needsLaborConfirmation));assert(rows.every(row=>!row.potentialExtraWork));
assert.equal(propose('Carpet off stairs and starting flooring on stairs. Tomorrow continue stairs.').length,2);
assert.equal(propose('Installed 1,500 SF flooring.')[0].quantity,1500);assert.equal(propose('Installed 2.5 CY concrete.')[0].quantity,2.5);
assert.equal(propose('Measured 20 feet of trim.')[0].quantity,null);
for(const note of ['Tomorrow installed 3 tiles.','We will install flooring.','Not installed 3 tiles.','We did not install 3 tiles.','No work occurred.','Safety concern: unguarded opening.'])assert.equal(propose(note).length,0,note);
const partial=normalize([{description:'Bathroom tile',evidence:'added three more tiles to the bathroom',quantity:3,unit:'EA',laborHours:8}],notes);assert.equal(partial.length,5);assert.equal(partial[0].quantity,3);assert.equal(partial[0].needsLaborConfirmation,true);
const hallucinated=normalize([{description:'Stairs',evidence:'started on the stairs',quantity:20,unit:'LF',laborHours:8}],'started on the stairs. Measured 20 feet of trim.');assert(hallucinated.every(row=>row.quantity===null));
const measurement=normalize([{description:'Trim',evidence:'Measured 20 feet of trim',quantity:20,unit:'LF',laborHours:8}],'Measured 20 feet of trim.');assert.equal(measurement[0].quantity,null);
assert.equal(propose('Completed extra work: removed damaged trim.')[0].potentialExtraWork,true);
assert.deepEqual(reviewSuggestions(rows),reviewSuggestions(JSON.parse(JSON.stringify(rows))));assert.equal(reviewSuggestions([{description:'Draft only',quantity:null,unit:'',laborHours:0}])[0].quantity,null);
console.log('Daily work extraction: five performed scopes, explicit written count, pending measurement/labor/scope, negative/future exclusion, partial provider backstop and safe draft shape passed.');

assert.equal(propose('Instalamos 20 LF de tubería.')[0].quantity,20);assert.equal(propose('No instalamos 20 LF de tubería.').length,0);const duplicates=normalize([{description:'Tile A',evidence:'Added three tiles bathroom'},{description:'Tile B',evidence:'Added three tiles bathroom'}],'Added three tiles bathroom.');assert(duplicates.every(row=>row.quantity===null));

assert.equal(propose('Measured 20 feet trim.').every(row=>row.quantity===null),true);
