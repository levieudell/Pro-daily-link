'use strict';
// Human-verified expected values, NOT output from a model or the local parser.
// Source page 1: public filled Smartsheet template. Page 2 is blank; page 3 disclaimer.
const materials = [
  ['Primer (interior)',10,180], ['Matte wall paint (white)',15,480],
  ['Ceiling paint (flat)',5,145], ['Trim paint (semi-gloss)',4,120],
  ['Primer (exterior)',5,110], ['Latex paint (beige)',10,380], ['Caulking tubes',12,78]
];
const labor = [
  ['Wall prep + patching',8,50,400], ['Wall painting',18,50,900],
  ['Ceiling painting',6,50,300], ['Trim & Doors',10,50,500],
  ['Scrape & prep siding',12,55,660], ['Apply 2 coats paint',16,55,880]
];
const common = {internalCost:null,scopeStatus:'included'};
module.exports = {
  estimateNumber:'P-1125', documentTotal:5133,
  lines:[...materials.map(([description,quantity,amount])=>({...common,description,quantity,unit:'',unitPrice:null,amount,budgetHours:null,confidence:'medium',reviewNotes:['Material UOM not printed; Cost column meaning requires review.']})),...labor.map(([description,quantity,unitPrice,amount])=>({...common,description,quantity,unit:'HR',unitPrice,amount,budgetHours:quantity,confidence:'high',reviewNotes:[]}))],
  adjustments:[],reviewNotes:[]
};
