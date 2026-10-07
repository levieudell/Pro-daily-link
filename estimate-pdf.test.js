'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
// TEST_LEGACY_SOURCE lets the same fixtures establish the pre-fix failures.
let parser;
if (process.env.TEST_LEGACY_SOURCE) {
  const source = fs.readFileSync(process.env.TEST_LEGACY_SOURCE, 'utf8').split(/\r?\n/).filter(line => /^function (pdfText|estimateDraft)\(/.test(line)).join('\n');
  parser = new Function('zlib', source + '; return {pdfText,estimateDraft};')(zlib);
} else parser = require('./estimate-pdf');

function makePdf(rows, { cells = false, array = false } = {}) {
  const escape = value => value.replace(/[()\\]/g, '\\$&');
  const content = rows.flatMap((row, index) => (cells ? row : [row]).map((text, column) => `BT /F1 11 Tf 1 0 0 1 ${40 + column * 120} ${750 - index * 30} Tm ${array ? `[( ${escape(text)} )] TJ` : `(${escape(text)}) Tj`} ET`)).join('\n');
  const compressed = zlib.deflateSync(Buffer.from(content));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`), compressed, Buffer.from('\nendstream')])];
  const pieces = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let size = pieces[0].length;
  objects.forEach((object, index) => { offsets.push(size); const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); pieces.push(bytes); size += bytes.length; });
  pieces.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`));
  return Buffer.concat(pieces);
}
const fixtures = [
  { name: 'explicit-unit', rows: ['SYNTHETIC DOCUMENT ONLY', 'Estimate #QB-100', 'Description Quantity Unit Amount', 'Concrete slab 100 SF $5000.00', 'Total $5000.00'] },
  { name: 'qty-rate-amount', rows: ['SYNTHETIC DOCUMENT ONLY', 'Estimate #QB-101', 'Product Service Description QTY RATE AMOUNT', 'Concrete slab 100 $50.00 $5000.00', 'Total $5000.00'] },
  { name: 'unit-rate-amount-labor', rows: ['SYNTHETIC DOCUMENT ONLY', 'Estimate #QB-102', 'Description Quantity Unit Rate Amount', 'Concrete slab 100 SF $50.00 $5000.00', 'Estimated labor 16 HR', 'Total $5000.00'] },
  { name: 'positioned-cells', rows: [['Description', 'QTY', 'RATE', 'AMOUNT'], ['Concrete slab', '100', '$50.00', '$5000.00'], ['Total', '$5000.00']], options: { cells: true } },
  { name: 'wrapped-description', rows: ['Description Quantity Unit Amount', 'Concrete slab', 'at rear entrance', '100 SF $5000.00', 'Total $5000.00'], options: { array: true } },
  { name: 'ambiguous-without-columns', rows: ['SYNTHETIC DOCUMENT ONLY', 'Estimate #QB-103', 'Concrete slab 100 $50.00 $5000.00', 'Total $5000.00'] },
  { name: 'ambiguous-extra-amounts', rows: ['Description Quantity Unit Rate Amount', 'Concrete slab 100 SF $50.00 $5000.00 $6000.00', 'Total $6000.00'] },
  { name: 'rate-total-mismatch', rows: ['Description QTY RATE AMOUNT', 'Concrete slab 100 $50.00 $4000.00', 'Total $4000.00'] },
  { name: 'wrapped-numbered-description', rows: ['Description Quantity Unit Amount', 'Concrete slab phase 2', '100 SF $5000.00', 'Total $5000.00'] },
  { name: 'missing-amount', rows: ['Description Quantity Unit Rate Amount', 'Concrete slab 100 SF $50.00', 'Total $5000.00'] },
  { name: 'rate-only', rows: ['Description Quantity Unit Rate', 'Concrete slab 100 SF $50.00'] },
  { name: 'hidden-quantity', rows: ['Description Rate Amount', 'Concrete slab $50.00 $5000.00', 'Total $5000.00'] },
  { name: 'hidden-rate', rows: ['Description QTY Amount', 'Concrete slab 100 $5000.00', 'Total $5000.00'] },
  { name: 'reordered-columns', rows: ['Description Amount QTY RATE', 'Concrete slab 5000 100 50', 'Total $5000.00'] },
  { name: 'builder-cost', rows: ['Description QTY Builder Cost Unit Price Client Total', 'Concrete slab 100 $30.00 $50.00 $5000.00', 'Total $5000.00'] },
  { name: 'not-included', rows: ['Description QTY RATE AMOUNT', 'Concrete slab 100 $50.00 $5000.00', 'Optional coating 10 $10.00 $100.00 Not included', 'Total $5000.00'] },
  { name: 'non-finite-quantity', rows: ['Description Quantity Unit Amount', `Concrete slab ${'9'.repeat(310)} SF $5000.00`, 'Total $5000.00'] },
  { name: 'priced-labor-scope', rows: ['Description Quantity Unit Amount', 'Labor installation 16 HR $1600.00', 'Total $1600.00'] },
  { name: 'desktop-markup', rows: ['Description QTY Rate Amount Markup Total', 'Framing 30 $45.00 $1350.00 42% $1917.00', 'Total $1917.00'] },
  { name: 'revenue-only', rows: ['Description Revenue', 'Framing $1917.00', 'Total $1917.00'] },
  { name: 'headerless-two-prices', rows: ['Concrete slab 100 SF $50.00 $5000.00', 'Total $5000.00'] }
];

function run() {
  const results = fixtures.map(fixture => ({ name: fixture.name, ...parser.estimateDraft(parser.pdfText(makePdf(fixture.rows, fixture.options))) }));
  const byName = name => results.find(row => row.name === name);
  assert.equal(byName('explicit-unit').lines[0].description, 'Concrete slab', 'headers must not leak into description');
  for (const name of ['explicit-unit', 'qty-rate-amount', 'unit-rate-amount-labor', 'positioned-cells', 'wrapped-description']) {
    const result = byName(name); assert.equal(result.lines.length, 1, name); assert.equal(result.lines[0].quantity, 100, name); assert.equal(result.lines[0].amount, 5000, name); assert.equal(result.documentTotal, 5000, name); assert.equal(result.reconciled, true, name);
  }
  assert.equal(byName('qty-rate-amount').lines[0].unit, '');
  assert.equal(byName('positioned-cells').lines[0].unit, '');
  assert.match(byName('qty-rate-amount').reviewWarnings.join(' '), /no unit/);
  assert.equal(byName('explicit-unit').lines[0].unit, 'SF');
  assert.equal(byName('unit-rate-amount-labor').lines[0].budgetHours, null);
  assert.match(byName('unit-rate-amount-labor').reviewWarnings.join(' '), /Labor information/);
  assert.equal(byName('wrapped-description').lines[0].description, 'Concrete slab at rear entrance');
  for (const name of ['ambiguous-without-columns', 'ambiguous-extra-amounts', 'wrapped-numbered-description']) { assert.equal(byName(name).lines.length, 0, name); assert.ok(byName(name).reviewWarnings.length, name); }
  assert.equal(byName('rate-total-mismatch').lines[0].amount, 4000); assert.equal(byName('rate-total-mismatch').lines[0].confidence, 'medium'); assert.match(byName('rate-total-mismatch').reviewWarnings.join(' '), /does not match/);
  assert.equal(byName('missing-amount').lines[0].amount, null); assert.notEqual(byName('missing-amount').lines[0].confidence, 'high'); assert.ok(byName('missing-amount').reviewWarnings.length);
  assert.equal(byName('rate-only').lines[0].unitPrice, 50); assert.equal(byName('rate-only').lines[0].amount, null);
  assert.equal(byName('hidden-quantity').lines[0].quantity, null); assert.equal(byName('hidden-quantity').lines[0].amount, 5000);
  assert.equal(byName('hidden-rate').lines[0].quantity, 100); assert.equal(byName('hidden-rate').lines[0].amount, 5000);
  for (const name of ['reordered-columns', 'builder-cost', 'non-finite-quantity']) { assert.equal(byName(name).lines.length, 0, name); assert.ok(byName(name).reviewWarnings.length, name); }
  assert.equal(byName('not-included').lines.length, 1); assert.equal(byName('not-included').lineTotal, 5000); assert.match(byName('not-included').reviewWarnings.join(' '), /excluded/);
  assert.equal(byName('priced-labor-scope').lines.length, 1); assert.equal(byName('priced-labor-scope').lines[0].budgetHours, null);
  assert.equal(byName('desktop-markup').lines.length,0); assert.match(byName('desktop-markup').reviewWarnings.join(' '),/cost labels/);
  assert.equal(byName('revenue-only').lines[0].quantity,null); assert.equal(byName('revenue-only').lines[0].amount,1917);
  assert.equal(byName('headerless-two-prices').lines[0].amount,null); assert.match(byName('headerless-two-prices').reviewWarnings.join(' '),/rightmost price/);
  assert.equal(parser.estimateDraft('').requiresOcr, true);
  const literal = Buffer.from('%PDF-1.4\nstream\nBT (Deck framing 100 SF $5000.00) Tj (Total $5000.00) Tj ET\nendstream\n%%EOF');
  assert.equal(parser.estimateDraft(parser.pdfText(literal)).lines[0].description, 'Deck framing');
  const scan = fs.readFileSync(path.join(__dirname,'test-fixtures','estimates','synthetic-scanned-estimate.pdf'));
  assert.equal(parser.pdfText(scan), ''); assert.equal(parser.estimateDraft(parser.pdfText(scan)).requiresOcr, true);
  const publicSample = parser.estimateDraft(parser.pdfText(fs.readFileSync(path.join(__dirname,'test-fixtures','estimates','smartsheet-painting-public.pdf'))));
  assert.equal(publicSample.lines.length, 0, 'Complex public sample is routed for assisted review, not silently guessed'); assert.equal(publicSample.requiresAiReview, true);
  console.log(`Estimate PDF regressions: ${fixtures.length} valid compressed synthetic layouts, legacy literal PDF, raster scan and authentic public sample limitation passed`);
}
if (require.main === module) run();
module.exports = { makePdf, fixtures };
