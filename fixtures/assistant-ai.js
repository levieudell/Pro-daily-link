'use strict';
const { emptyLedger } = require('../project-assistant-budget');
const { FIELDS } = require('../project-assistant-intent');
function memoryStore() {
  let revision = 0, ledger = emptyLedger();
  return { async load() { return { revision, ledger: structuredClone(ledger) }; }, async compareAndSwap(previous, next) { if (previous.revision !== revision) return false; revision++; ledger = structuredClone(next); return true; }, read() { return structuredClone(ledger); }, set(value) { ledger = structuredClone(value); revision++; } };
}
const changes = values => Object.fromEntries(FIELDS.map(key => [key, values[key] ?? null]));
const utterances = {
  'Schedule Chloe Andy at market Street tomorrow': { action:'schedule',people:'Chloe Andy',project:'market Street',date:'tomorrow' },
  '8 AM': { start:'8 AM' }, '4 PM': { end:'4 PM' },
  'Frame the west wall': { activity:'Frame the west wall' },
  'Check the layout with the supervisor.': { instructions:'Check the layout with the supervisor.' },
  'Make that tomorrow instead': { date:'tomorrow' },
  'Actually finish at 3 PM': { end:'3 PM' },
  'Put Chloe and Andi on Market Street tomorrow from 8 AM to 4 PM to frame the wall. Tell them to verify the layout.': { action:'schedule',people:'Chloe and Andi',project:'Market Street',date:'tomorrow',start:'8 AM',end:'4 PM',activity:'frame the wall',instructions:'verify the layout' },
  'Add a note for Market Street: Gate opens at 8 AM.': { action:'note',project:'Market Street',text:'Gate opens at 8 AM.' }
};
module.exports = { memoryStore, changes, utterances };
