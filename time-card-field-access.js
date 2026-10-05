'use strict';

const crypto = require('node:crypto');
const payPeriods = require('./pay-periods');
const status = card => String(card?.status ?? card?.Status ?? card?.state ?? card?.approvalStatus ?? '').trim().toLowerCase();
const revision = card => crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex');

function lockedPeriod(db, card) {
  const exports = db.payPeriodExports || [];
  if (exports.some(record => (record.summary?.records || []).some(row => String(row.id) === String(card.id)))) return true;
  return (db.payPeriods || []).some(period => {
    if (period.status !== 'closed' && !exports.some(record => record.periodId === period.id)) return false;
    const date = payPeriods.dateAt(card.inAt, period.timeZone || db.company?.timezone || 'America/Los_Angeles');
    return date && date >= period.from && date <= period.to;
  });
}

function activeWorkday(db,card){return (db.workdays||[]).find(row=>Number(row.id)===Number(card.workdayId)&&row.status==='active')}
function canCompleteWorkday(db,card){
  const workday=activeWorkday(db,card);
  return Boolean(workday&&Array.isArray(workday.memberIds)&&workday.memberIds.length===1&&Number(workday.memberIds[0])===Number(card.memberId)&&!(db.timeCards||[]).some(row=>!row.deletedAt&&Number(row.workdayId)===Number(workday.id)&&Number(row.memberId)!==Number(card.memberId)));
}
function completeOwnWorkday(db,card,actor,reason){
  if(!canCompleteWorkday(db,card))return false;
  const workday=activeWorkday(db,card),before={status:workday.status,startedAt:workday.startedAt,endedAt:workday.endedAt};
  workday.status='complete';workday.startedAt=card.inAt;workday.endedAt=card.outAt;workday.endNotes ||= reason;
  workday.history ||= [];workday.history.push({action:'Own workday completed from time correction',by:actor,at:new Date().toISOString(),reason,before,after:{status:workday.status,startedAt:workday.startedAt,endedAt:workday.endedAt}});
  return true;
}

function access(db, user, card) {
  const result = { canEdit: false, canSubmit: false, reason: '', revision: revision(card) };
  if (!['field', 'foreman'].includes(user?.role) || !Number(user.memberId) || !(db.team || []).some(member => Number(member.id) === Number(user.memberId)) || Number(card.memberId) !== Number(user.memberId)) {
    result.reason = 'You can only change your own time cards.';
  } else if (card.deletedAt || ['deleted', 'void'].includes(status(card))) {
    result.reason = 'This time card was removed. Ask your office time administrator for a correction.';
  } else if (lockedPeriod(db, card) || card.lockedAt || card.exportedAt || card.payrollLockedAt) {
    result.reason = 'This time is in a closed or exported pay period. Ask your office time administrator to correct it and issue a corrected export.';
  } else if ([card.status,card.Status,card.state,card.approvalStatus].some(value=>String(value||'').trim().toLowerCase()==='approved') || card.approvedAt || card.approvedBy) {
    result.reason = 'This time is approved. Ask your office time administrator to return it to Draft before correcting it.';
  } else if (!['draft', 'rejected'].includes(status(card)) || [card.status,card.Status,card.state,card.approvalStatus].filter(value=>value!=null&&String(value).trim()).some(value=>!['draft','rejected'].includes(String(value).trim().toLowerCase()))) {
    result.reason = status(card) === 'submitted' ? 'This time is awaiting review. Ask your office time administrator to return it to Draft if a correction is needed.' : 'Ask your office time administrator to review this time card before correcting it.';
  } else if (activeWorkday(db,card)&&!canCompleteWorkday(db,card)) {
    result.reason = 'This is a shared active crew workday. End the workday first, or ask your office time administrator to correct it without changing anyone else’s time.';
  } else {
    result.canEdit = true;
    result.canSubmit = !activeWorkday(db,card)&&payPeriods.completeCard(card);
    result.reason = result.canSubmit ? 'Review your times, then submit for office approval.' : 'Open and edit this card to enter the actual end time before submitting.';
  }
  return result;
}

function validBreaks(breaks, inAt, outAt) {
  if (!Array.isArray(breaks)) return false;
  const intervals = [];
  for (const row of breaks) {
    if (!row || !['paid_rest', 'unpaid_meal'].includes(row.type)) return false;
    if (!row.startedAt && !row.endedAt) { if (!row.missed && !row.interrupted) return false; continue; }
    const start = Date.parse(row.startedAt), end = Date.parse(row.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < Date.parse(inAt) || end > Date.parse(outAt)) return false;
    if (intervals.some(([from, to]) => start < to && from < end)) return false;
    intervals.push([start, end]);
  }
  return true;
}

function syncDraftReport(db, card) {
  const workday=(db.workdays||[]).find(row=>Number(row.id)===Number(card.workdayId)),reportId=card.reportId||workday?.reportId;
  const report=(db.reports||[]).find(row=>Number(row.id)===Number(reportId));
  if (!report || String(report.status||'').toLowerCase()!=='draft') return false;
  const hours=(db.timeCards||[]).filter(row=>!row.deletedAt&&Number(row.memberId)===Number(card.memberId)&&(Number(row.reportId)===Number(report.id)||!row.reportId&&(db.workdays||[]).some(day=>Number(day.id)===Number(row.workdayId)&&Number(day.reportId)===Number(report.id)))).reduce((sum,row)=>sum+(Number(row.hours)||0),0);
  report.laborEntries ||= [];
  const existing=report.laborEntries.find(row=>Number(row.memberId)===Number(card.memberId));
  if(existing)existing.hours=Math.round(hours*100)/100;
  else if(hours>0)report.laborEntries.push({memberId:card.memberId,hours:Math.round(hours*100)/100,crew:(db.team||[]).find(row=>Number(row.id)===Number(card.memberId))?.crew||'Unassigned'});
  const total=report.laborEntries.reduce((sum,row)=>sum+(Number(row.hours)||0),0),production=report.productionEntries||[],allocated=production.reduce((sum,row)=>sum+(Number(row.laborHours)||0),0);
  if(production.length===1)production[0].laborHours=Math.round(total*100)/100;
  else if(allocated>0)production.forEach(row=>{row.laborHours=Math.round(total*(Number(row.laborHours)||0)/allocated*100)/100});
  report.history ||= [];report.history.push({action:'Labor synced from time-card correction',by:'Time cards',at:new Date().toISOString()});
  return true;
}

module.exports = { activeWorkday, completeOwnWorkday, syncDraftReport, access, lockedPeriod, revision, status, validBreaks };
