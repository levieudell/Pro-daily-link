'use strict';
// Spreadsheet software interprets formula-leading text even inside quoted CSV cells.
function pdlCsvCell(value, options = {}) {
  let text = value == null ? '' : String(value);
  if (typeof value !== 'number' && /^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
  // Leading control characters are also spreadsheet formula triggers.
  if (typeof value !== 'number' && /^[\t\r\n]/.test(text)) text = "'" + text;
  if (options.quoteAll === false && !/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
if (typeof module !== 'undefined' && module.exports) module.exports = pdlCsvCell;
else globalThis.pdlCsvCell = pdlCsvCell;
