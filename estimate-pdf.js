'use strict';

const zlib = require('node:zlib');
const NUMBER = '(?:\\$\\s*)?\\d+(?:,\\d{3})*(?:\\.\\d+)?';
const numeric = value => Number(String(value).replace(/[$,\s]/g, ''));

// This is deliberately a limited embedded-text reader, not a general PDF renderer.
// Preserve positioned rows so column headings cannot become line descriptions.
function pdfText(buffer) {
  const rows = [];
  for (const stream of buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let bytes = Buffer.from(stream[1], 'latin1');
    try { bytes = zlib.inflateSync(bytes, { maxOutputLength: 20_000_000 }); } catch {}
    const content = bytes.toString('latin1');
    if (!/\bBT\b/.test(content) || !/\bET\b/.test(content)) continue;
    const tokens = content.match(/\((?:\\[\s\S]|[^\\()])*\)|\[(?:\((?:\\[\s\S]|[^\\()])*\)|[^\]])*\]|-?\d+(?:\.\d+)?|[A-Za-z*'"]+/g) || [];
    const operands = [], fragments = [];
    let x = 0, y = null, leading = 0, sequence = 0;
    const decode = token => token.slice(1, -1).replace(/\\(?:\r\n|\r|\n)/g, '').replace(/\\([0-7]{1,3}|[nrtbf()\\])/g, (_, escaped) => /^[0-7]/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escaped] || escaped));
    const add = text => {
      if (text.trim()) fragments.push({ text, x, y, sequence: sequence++ });
      x += text.length * 6;
    };
    for (const token of tokens) {
      if (token.startsWith('(') || token.startsWith('[') || /^-?\d/.test(token)) { operands.push(token); continue; }
      const values = operands.map(Number);
      if (token === 'BT') { x = 0; y = null; }
      else if (token === 'Tm' && values.length >= 6) { x = values.at(-2); y = values.at(-1); }
      else if ((token === 'Td' || token === 'TD') && values.length >= 2) { x += values.at(-2); y = (y || 0) + values.at(-1); if (token === 'TD') leading = -values.at(-1); }
      else if (token === 'TL') leading = values.at(-1) || 0;
      else if (token === 'T*') { y = (y || 0) - leading; x = 0; }
      else if (token === 'Tj' || token === "'" || token === '"') {
        if (token !== 'Tj') { y = (y || 0) - leading; x = 0; }
        const literal = operands.at(-1); if (literal?.startsWith('(')) add(decode(literal));
      } else if (token === 'TJ') {
        const array = operands.at(-1) || '';
        const parts = array.match(/\((?:\\[\s\S]|[^\\()])*\)|-?\d+(?:\.\d+)?/g) || [];
        add(parts.map(part => part.startsWith('(') ? decode(part) : Number(part) < -120 ? ' ' : '').join(''));
      }
      operands.length = 0;
    }
    const groups = [], byHeight = new Map();
    for (const fragment of fragments) {
      const key = Math.floor(fragment.y / 2);
      const previous = fragment.y == null ? null : [byHeight.get(key - 1), byHeight.get(key), byHeight.get(key + 1)].find(group => group && Math.abs(group.y - fragment.y) < 2);
      if (previous) previous.fragments.push(fragment);
      else { const group = { y: fragment.y, fragments: [fragment] }; groups.push(group); if (fragment.y != null) byHeight.set(key, group); }
    }
    for (const group of groups) rows.push(group.fragments.sort((a, b) => a.x - b.x || a.sequence - b.sequence).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim());
  }
  return rows.join('\n').trim();
}

function estimateDraft(text) {
  const lines = [], reviewWarnings = [];
  let pending = [], header = null, documentTotal = null;
  const warn = message => { if (!reviewWarnings.includes(message)) reviewWarnings.push(message); };
  for (let row of String(text).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (/\bnot included\b/i.test(row)) { warn('A row marked Not included was excluded from active scope and totals.'); pending = []; continue; }
    // Some exporters place the final total in the same text operator as the item.
    const total = row.match(new RegExp(`\\b(?:estimate\\s+total|total)\\s*(${NUMBER})\\s*$`, 'i'));
    if (total) { documentTotal = numeric(total[1]); row = row.slice(0, total.index).trim(); if (!row) { pending = []; continue; } }
    if (/\b(?:qty|quantity|rate|amount|price|cost|total|revenue)\b/i.test(row) && /\b(?:description|product|service)\b/i.test(row)) {
      const quantity = row.search(/\b(?:qty|quantity)\b/i), rate = row.search(/\b(?:rate|unit\s+price)\b/i), amount = row.search(/\b(?:amount|total|revenue)\b/i);
      const positions = [quantity, rate, amount].filter(value => value >= 0);
      header = { quantity: quantity >= 0, rate: rate >= 0, amount: amount >= 0, valid: positions.length > 0 && positions.every((value,index) => !index || value > positions[index-1]) && !/\b(?:cost|markup)\b/i.test(row) && !(/\bamount\b/i.test(row) && /\btotal\b/i.test(row)) };
      if (!header.valid) warn('Unsupported or ambiguous column order or cost labels. Review these lines manually; selling amounts were not guessed.');
      pending = []; continue;
    }
    if (/^(?:synthetic\b|estimate\b|quote\b|customer\b|bill\s+to\b|ship\s+to\b|date\b|address\b|subtotal\b|tax\b|discount\b|deposit\b|balance\b|thank\b|terms\b|page\s+\d)/i.test(row)) { pending = []; continue; }
    // Labor on a sales document must never silently become a work quantity or
    // labor budget. Catalog rates and the editable hours review remain authoritative.
    if (/^(?:estimated\s+)?(?:labor|labour)(?:\s+hours)?\s*:?\s*\d+(?:\.\d+)?\s*(?:HR|HRS|HOURS)?$/i.test(row)) { warn('Labor information was not converted to budget hours. Review hours separately.'); pending = []; continue; }
    if (header && !header.valid) { if (/\d|\$/.test(row)) warn('Some estimate text could not be extracted safely. Compare all lines with the PDF before approving.'); pending = []; continue; }
    const explicit = row.match(new RegExp(`^(.*?)\\s*(${NUMBER})\\s+(EA|SF|LF|CY|SY|TON|HR|DAY|LS)\\b(?:\\s+(${NUMBER}))?(?:\\s+(${NUMBER}))?\\s*$`, 'i'));
    const columnCount = header ? [header.quantity,header.rate,header.amount].filter(Boolean).length : 0;
    const withoutUnit = !explicit && columnCount && row.match(new RegExp(`^(.*?)\\s+(${NUMBER})${`\\s+(${NUMBER})`.repeat(columnCount - 1)}\\s*$`, 'i'));
    const match = explicit || withoutUnit;
    if (match) {
      // Only join wrapped descriptions when this row contains numeric cells alone.
      // An independently complete row must not absorb an unknown preceding header.
      const description = (match[1].trim() || pending.join(' ')).trim(); pending = [];
      if (!description || !/[A-Za-z]/.test(description) || /\$/.test(description) || (!explicit && /\b\d+\s+(?:EA|SF|LF|CY|SY|TON|HR|DAY|LS)\b/i.test(description))) { warn('An incomplete estimate row could not be extracted. Compare the PDF before approving.'); continue; }
      const unit = explicit ? match[3].toUpperCase() : '';
      let quantity = explicit ? numeric(match[2]) : null, rate = null, amount = null;
      if (explicit) {
        if (match[5] && header?.rate && header.amount) { rate = numeric(match[4]); amount = numeric(match[5]); }
        else if (match[5]) warn('Financial columns are ambiguous. The selling amount was left unknown rather than choosing the rightmost price.');
        else if (match[4] && header?.rate) { if (!header.amount) rate = numeric(match[4]); else warn('A rate/amount column is missing. The selling amount was left unknown for review.'); }
        else if (match[4]) { amount = numeric(match[4]); if (!header) warn('A headerless line amount needs verification against the PDF.'); }
      } else {
        let index = 2;
        if (header.quantity) quantity = numeric(match[index++]);
        if (header.rate) rate = numeric(match[index++]);
        if (header.amount) amount = numeric(match[index++]);
      }
      if ([quantity, rate, amount].some(value => value != null && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) { warn('An unsafe numeric value was not extracted. Review this row manually.'); continue; }
      if (quantity != null && quantity <= 0) { warn('A non-positive quantity was not extracted. Review this row manually.'); continue; }
      const amountMismatch = quantity != null && rate != null && amount != null && Math.abs(quantity * rate - amount) > .01;
      if (quantity == null) warn('Some lines have no quantity in the PDF. Enter and verify each missing quantity before approving.');
      if (!unit) warn('Some lines have no unit in the PDF. Enter and verify each missing unit before approving.');
      if (amountMismatch) warn('Quantity × rate does not match a line amount. Verify the PDF and amount before approving.');
      if (amount == null) warn('Some selling line amounts are unknown. Review amounts separately from unit rates.');
      lines.push({ description, quantity, unit, unitPrice: rate, amount, budgetHours: null, confidence: !header || quantity == null || !unit || amount == null || amountMismatch ? 'medium' : 'high' });
    } else if (/\d|\$/.test(row)) {
      warn('Some estimate text could not be extracted safely. Compare all lines with the PDF before approving.'); pending = [];
    } else {
      pending.push(row);
      if (pending.length > 2) { pending = []; warn('An ambiguous multiline description was not extracted. Compare the PDF before approving.'); }
    }
  }
  if (documentTotal != null && (!Number.isFinite(documentTotal) || documentTotal > Number.MAX_SAFE_INTEGER)) { documentTotal = null; warn('The document total is invalid and was left unknown.'); }
  let lineTotal = lines.reduce((sum, line) => sum + (line.amount || 0), 0);
  if (!Number.isFinite(lineTotal) || lineTotal > Number.MAX_SAFE_INTEGER) { lineTotal = null; warn('The line total is invalid and was left unknown.'); }
  if (!lines.length && text.trim().length >= 40) warn('No supported estimate lines were found. Use manual estimate entry or a supported PDF layout.');
  return { lines, documentTotal, lineTotal, reconciled: lineTotal != null && lines.every(line => line.amount != null) && documentTotal != null && Math.abs(documentTotal - lineTotal) < .01, requiresOcr: text.trim().length < 40, requiresAiReview: !lines.length && text.trim().length >= 40, reviewWarnings };
}

module.exports = { pdfText, estimateDraft };
