'use strict';
// Older scope tests passed because they called reviewScope without notes.
// A production whose description already named the estimate line, or the only
// line with that unit, matched. Live OpenAI renamed "curb" to "Slab on grade"
// and the no-notes matcher trusted that name. With notes present, those
// productions are ignored and the note itself is the source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const scope = require('./field-daily-scope');
const dailyWork = require('./daily-work-extraction');

const NOTE = 'Poured 40 LF of curb on north side, 3 guys, extra work: owner asked us to patch 2 potholes by the gate, used 6 yards of concrete';
const clinic = [
  { id: 1, name: 'Curb', unit: 'LF', plannedQuantity: 800, budgetHours: 80 },
  { id: 2, name: 'Slab on grade', unit: 'SF', plannedQuantity: 12000, budgetHours: 480 },
  { id: 3, name: 'Footings', unit: 'CY', plannedQuantity: 240, budgetHours: 240 }
];
const invented = [
  { description: 'Slab on grade', quantity: null, unit: 'x' },
  { description: 'Slab on grade', quantity: null, unit: 'x' }
];

const grounded = scope.reviewScope({ notes: NOTE, productions: invented, estimateItems: clinic, approvedQuantities: {}, crewHours: 0 });
assert.equal(grounded.lines.length, 1);
assert.equal(grounded.lines[0].description, 'Curb');
assert.equal(grounded.lines[0].quantity, 40);
assert.equal(grounded.lines[0].unit, 'LF');
assert.equal(grounded.lines.some(line => /slab/i.test(line.description)), false);
assert.match(grounded.materials, /6 yards of concrete/);
const extra = grounded.flags.find(flag => flag.reason === 'stated_extra');
assert.ok(extra, 'explicit extra-work language raises a flag');
assert.match(extra.description, /potholes/);
assert.equal(grounded.hours.ask, true);
assert.equal(grounded.hours.headcount, 3);

const normalized = dailyWork.normalize(invented, NOTE);
const afterNormalize = scope.reviewScope({ notes: NOTE, productions: normalized, estimateItems: clinic });
assert.equal(afterNormalize.lines.some(line => /slab/i.test(line.description)), false, 'normalized OpenAI-shaped lines still cannot invent a slab');

const unmatched = scope.reviewScope({ notes: NOTE, productions: invented, estimateItems: clinic.filter(item => item.name !== 'Curb') });
assert.equal(unmatched.lines.length, 0, 'a missing curb line does not fall through to slab');
assert.ok(unmatched.flags.some(flag => flag.kind === 'pick' && flag.reason === 'no_match'));
assert.ok(unmatched.flags.some(flag => flag.reason === 'stated_extra'));

const foundation = [
  { id: 1, name: 'Foundation concrete', unit: 'CY', plannedQuantity: 180, budgetHours: 48 },
  { id: 2, name: 'Slab on grade', unit: 'SF', plannedQuantity: 4200, budgetHours: 160 }
];
const poured = scope.reviewScope({ notes: 'Poured 12 yards of foundation concrete.', productions: [{ description: 'Slab on grade', quantity: 12, unit: 'SF' }], estimateItems: foundation });
assert.equal(poured.lines[0].estimateItemId, 1);
assert.equal(poured.lines[0].quantity, 12);
assert.equal(poured.lines[0].unit, 'CY');

const crew = scope.statedCrew('3 guys for 8 hours');
assert.equal(crew.total, 24);
assert.equal(crew.ask, false);

const blocked = scope.sendGate({ flags: grounded.flags, laborHours: 0, openClock: false, lines: grounded.lines });
assert.ok(blocked.block.some(line => /hours/i.test(line)));
assert.ok(blocked.block.some(line => /flag/i.test(line)));
const decided = grounded.flags.map(flag => scope.decideFlag(flag, flag.reason === 'stated_extra' ? 'bill' : 'noted'));
const ready = scope.sendGate({ flags: decided, laborHours: 8, openClock: true, lines: grounded.lines });
assert.equal(ready.block.length, 0, 'answered flags and hours let Send continue');
assert.ok(ready.warn.some(line => /clocked in/i.test(line)));
const blankQty = scope.sendGate({ flags: decided, laborHours: 8, openClock: false, lines: [{ quantity: '', needsQuantity: true }] });
assert.ok(blankQty.block.some(line => /quantity/i.test(line)));

assert.equal(scope.clockOutMessage(''), 'Add what was completed before clocking out.');
assert.equal(scope.clockOutMessage('poured curb'), '');

const server = fs.readFileSync(__dirname + '/server.js', 'utf8');
const attach = server.slice(server.indexOf('function attachFieldScope'), server.indexOf('function recordFieldExtras'));
assert.match(attach, /notes=String\(input\?\.notes/);
assert.match(attach, /englishTranslation/);
assert.match(server, /Never rename curb/);
assert.match(server, /X-Robots-Tag/);
assert.match(server, /Outbound email is disabled in staging/);
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
assert.match(app, /endDayMessage\(/);
assert.match(app, /presentReportSent\(/);
assert.match(html, /id="end-day-message"/);
const notesTag = html.match(/<textarea id="end-day-notes"[^>]*>/)?.[0] || '';
assert.equal(/required/.test(notesTag), false);
assert.match(fs.readFileSync(__dirname + '/field-instant-daily.js', 'utf8'), /Sent to the office with gaps/);

console.log('Field note grounding checks passed.');
