'use strict';

const path = require('node:path');
const csvCell = require('./csv-cell');
const { splitHours, companyPayroll } = require('./payroll-overtime');
const { isApproved } = require('./time-card-approval');
const { dateAt } = require('./pay-periods');
const companyTimezone = require('./company-timezone');
const calendar = require('./payroll-ranges');

const CATEGORIES = ['REG', 'OT', 'DT'];
const templates = Object.freeze({
  'murder-the-guesswork': Object.freeze({
    columns: Object.freeze(['worker_name', 'worker_id', 'job_name', 'job_number', 'week_start', 'reg_hours', 'ot_hours', 'dt_hours', 'total_hours']),
    filename: ({ from, to }, format = 'csv') => `pdl-payroll-${from}-to-${to}.${format}`
  })
});
const defaultTemplate = templates['murder-the-guesswork'];
const empty = () => ({ REG: 0, OT: 0, DT: 0, total: 0 });
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
function sum(rows) {
  const cents = rows.reduce((out, row) => {
    for (const key of CATEGORIES) out[key] += Math.round(row[key] * 100);
    return out;
  }, empty());
  return { ...Object.fromEntries(CATEGORIES.map(key => [key, cents[key] / 100])), total: (cents.REG + cents.OT + cents.DT) / 100 };
}
function groups(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const id = String(row[key]);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(row);
  }
  return [...out.values()];
}

function buildPayrollExport(db, { from, to }) {
  if (!calendar.validDate(from) || !calendar.validDate(to) || from > to) fail('Choose a valid start and end date.');
  const timeZone = db.company.timezone || 'America/Los_Angeles';
  if (!companyTimezone.valid(timeZone)) fail('Configure a valid company timezone.');
  const weekStart = db.company.weekStart || 'monday';
  if (!['monday', 'sunday'].includes(weekStart)) fail('Use the company Monday or Sunday week start.');
  const firstDay = calendar.weekStart(from, weekStart), lastDay = calendar.addDays(calendar.weekStart(to, weekStart), 6);
  const approved = [];
  let unapprovedCount = 0;
  for (const card of db.timeCards || []) {
    if (card.deletedAt) continue;
    const date = dateAt(card.inAt, timeZone);
    if (!isApproved(card)) {
      if (date && date >= from && date <= to) unapprovedCount++;
      continue;
    }
    if (!date) fail('An approved punch needs a valid start date before export.');
    if (date >= firstDay && date <= lastDay) approved.push(card);
  }
  const overtime = companyPayroll(db.company).overtime;
  // Classify AND round full workweeks before selecting dates. Re-rounding a
  // partial week would move a cent between days compared with a full-week file.
  const fullWeeks = splitHours(approved, { overtime, weekStart, timeZone });
  const weeks = fullWeeks.map(week => {
    const punches = week.punches.filter(punch => punch.date >= from && punch.date <= to);
    return { memberId: week.memberId, weekStart: week.weekStart, punches,
      jobs: groups(punches, 'projectId').map(rows => ({ projectId: rows[0].projectId, ...sum(rows) })), ...sum(punches) };
  }).filter(week => week.punches.length);
  const workers = groups(weeks, 'memberId').map(rows => {
    const memberId = rows[0].memberId, member = (db.team || []).find(member => String(member.id) === String(memberId));
    return { memberId, name: member?.name || `Worker ${memberId}`, weeks: rows, ...sum(rows) };
  }).sort((a, b) => a.name.localeCompare(b.name) || String(a.memberId).localeCompare(String(b.memberId)));
  const exportRows = [];
  function values(worker, amounts, detail = {}) {
    return { worker_name: worker.name, worker_id: worker.memberId, job_name: '', job_number: '', week_start: '', ...detail,
      reg_hours: amounts.REG.toFixed(2), ot_hours: amounts.OT.toFixed(2), dt_hours: amounts.DT.toFixed(2), total_hours: amounts.total.toFixed(2) };
  }
  for (const worker of workers) {
    for (const week of worker.weeks) for (const job of week.jobs) {
      const project = (db.projects || []).find(project => String(project.id) === String(job.projectId));
      exportRows.push(values(worker, job, { job_name: project?.name || (job.projectId == null ? 'Company time' : `Job ${job.projectId}`),
        job_number: project?.code || '', week_start: week.weekStart }));
    }
    exportRows.push(values(worker, worker, { job_name: 'WORKER TOTAL' }));
  }
  return { companyName: db.company.name || 'Company', from, to, timeZone, weekStart, overtime, workers, rows: exportRows,
    totals: sum(workers), approvedCount: weeks.reduce((count, week) => count + week.punches.length, 0), unapprovedCount };
}

function payrollCsv(report, layout = defaultTemplate) {
  return [layout.columns, ...report.rows.map(row => layout.columns.map(key => row[key]))]
    .map(row => row.map(value => csvCell(value)).join(',')).join('\r\n') + '\r\n';
}

async function payrollPdf(report) {
  const PDFDocument = require('pdfkit');
  const fonts = name => path.join(__dirname, 'assets', 'fonts', name);
  // Keep one legible summary page. Large teams get a taller page, never omitted
  // workers or text shrunk below reading size; normal teams use US Letter.
  const doc = new PDFDocument({ autoFirstPage: false, font: fonts('inter-400.ttf'), info: { Title: 'Payroll summary - Murder the Guesswork', Author: 'Pro Daily Link' } });
  const chunks = [], completed = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('Inter', fonts('inter-400.ttf')).registerFont('InterBold', fonts('inter-700.ttf')).registerFont('Anton', fonts('anton-400.ttf'));
  const width = 612, margin = 36, nameWidth = 260;
  doc.font('Inter').fontSize(10);
  const heights = report.workers.map(worker => Math.max(26, doc.heightOfString(worker.name, { width: nameWidth - 12 }) + 12));
  const companyHeight = doc.font('InterBold').fontSize(14).heightOfString(report.companyName, { width: width - margin * 2 });
  const tableTop = 150 + companyHeight, tableHeight = heights.reduce((a, b) => a + b, 0);
  const height = Math.max(792, tableTop + tableHeight + 190);
  doc.addPage({ size: [width, height], margin });
  doc.rect(0, 0, width, height).fill('#F7F5F0');
  doc.rect(0, 0, width, 78).fill('#000000');
  doc.rect(0, 78, width, 3).fill('#FF6600');
  doc.fillColor('#FFFFFF').font('Anton').fontSize(26).text('PAYROLL SUMMARY', margin, 19);
  doc.font('Inter').fontSize(10).text('Murder the Guesswork', margin, 54);
  doc.fillColor('#000000').font('InterBold').fontSize(14).text(report.companyName, margin, 96, { width: width - margin * 2 });
  doc.font('Inter').fontSize(10).text(`${report.from} to ${report.to}  |  ${report.timeZone}`, margin, 102 + companyHeight);
  const rule = (value, label) => value == null ? `${label}: off` : `${label}: after ${value}h`;
  doc.text([rule(report.overtime.weeklyOver, 'Weekly OT'), rule(report.overtime.dailyOver, 'Daily OT'), rule(report.overtime.dailyDoubleOver, 'Daily DT')].join('  |  '), margin, 120 + companyHeight);
  doc.text(`Workweek starts ${report.weekStart === 'sunday' ? 'Sunday' : 'Monday'}. Approved punches only.`, margin, 135 + companyHeight);
  const columns = [nameWidth, 66, 66, 66, 82], labels = ['WORKER', 'REG', 'OT', 'DT', 'TOTAL'];
  let y = tableTop + 14;
  function row(texts, rowHeight, bold = false, heading = false) {
    if (heading) doc.rect(margin, y, width - margin * 2, rowHeight).fill('#000000');
    let x = margin;
    texts.forEach((text, i) => {
      doc.fillColor(heading ? '#FFFFFF' : '#000000').font(bold || heading ? 'InterBold' : 'Inter').fontSize(10)
        .text(String(text), x + 6, y + 7, { width: columns[i] - 12, align: i ? 'right' : 'left' });
      x += columns[i];
    });
    y += rowHeight;
    if (!heading) doc.moveTo(margin, y).lineTo(width - margin, y).strokeColor('#6E6E6E').lineWidth(0.5).stroke();
  }
  row(labels, 28, true, true);
  report.workers.forEach((worker, index) => row([worker.name, worker.REG.toFixed(2), worker.OT.toFixed(2), worker.DT.toFixed(2), worker.total.toFixed(2)], heights[index]));
  if (!report.workers.length) row(['No approved punches in this range.', '', '', '', ''], 28);
  row(['GRAND TOTAL', ...CATEGORIES.map(key => report.totals[key].toFixed(2)), report.totals.total.toFixed(2)], 30, true);
  doc.font('Inter').fontSize(9).fillColor('#000000')
    .text('Worker IDs in the CSV are PDL internal worker IDs, not payroll processor IDs.', margin, y + 20, { width: width - margin * 2 })
    .text("Extra-work flags don't create a separate pay line. Overnight hours use the day the punch started.", margin, y + 37, { width: width - margin * 2 });
  if (report.unapprovedCount) doc.text(report.unapprovedCount === 1 ? "1 punch not approved yet. It's left out." : `${report.unapprovedCount} punches not approved yet. They're left out.`, margin, y + 65);
  doc.end();
  return completed;
}

module.exports = { templates, defaultTemplate, buildPayrollExport, payrollCsv, payrollPdf };
