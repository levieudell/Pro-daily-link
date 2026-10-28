'use strict';

// Shared with the existing time-card routes; explicit Draft/Submitted wins over
// legacy approval metadata, and the last approval history entry is authoritative.
function status(card) {
  return String(card?.status ?? card?.Status ?? card?.state ?? card?.approvalStatus ?? '').trim().toLowerCase();
}
function isApproved(card) {
  const value = status(card);
  if (value === 'approved') return true;
  if (value === 'draft' || value === 'submitted') return false;
  if (!(card?.approvedAt || card?.approvedBy)) return false;
  const history = Array.isArray(card?.history) ? card.history : [];
  const last = history.filter(entry => entry && (entry.action === 'Approved' || entry.action === 'Unapproved')).at(-1);
  return !last || last.action === 'Approved';
}
module.exports = { status, isApproved };
