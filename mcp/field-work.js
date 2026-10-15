'use strict';

const dailyWork = require('../daily-work-extraction');

const UNIT_ALIASES = {
  cy: 'CY', yard: 'CY', yards: 'CY', yd: 'CY', yds: 'CY',
  sf: 'SF', 'sq ft': 'SF', 'square feet': 'SF', 'square foot': 'SF',
  lf: 'LF', ft: 'LF', feet: 'LF', foot: 'LF',
  ea: 'EA', each: 'EA', unit: 'EA', units: 'EA'
};

function canonicalUnit(unit) {
  const raw = String(unit || '').trim().toLowerCase();
  return UNIT_ALIASES[raw] || String(unit || '').trim().toUpperCase();
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function findEstimateItem(items, ref) {
  if (ref == null || ref === '') return null;
  const byId = (items || []).filter(item => String(item.id) === String(ref));
  if (byId.length === 1) return byId[0];
  const name = String(ref).trim().toLowerCase();
  if (!name) return null;
  const byName = (items || []).filter(item => String(item.name || '').trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0] : null;
}

function uniqueUnitItem(items, unit) {
  const wanted = canonicalUnit(unit);
  if (!wanted) return null;
  const matches = (items || []).filter(item => canonicalUnit(item.unit) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

function parseOwnHours(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*(?:hours|hrs|hr)\b/i);
  if (!match) return null;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return null;
  return round(hours);
}

function crewMember(team, selfMemberId, selfCrew, row, anyCrew) {
  const people = team || [];
  const allowed = person => anyCrew || Number(person.id) === Number(selfMemberId) || (selfCrew && String(person.crew || '').trim().toLowerCase() === String(selfCrew).trim().toLowerCase());
  if (row?.memberId != null && row.memberId !== '') {
    const person = people.find(member => Number(member.id) === Number(row.memberId));
    return person && allowed(person) ? person : null;
  }
  const name = String(row?.name || '').trim().toLowerCase();
  if (!name) return anyCrew ? null : people.find(member => Number(member.id) === Number(selfMemberId)) || null;
  const matches = people.filter(member => String(member.name || '').trim().toLowerCase() === name && allowed(member));
  return matches.length === 1 ? matches[0] : null;
}

// Structured lines win. Free text is only a fallback, and only onto an existing
// estimate line (exact name, scope match, or the only line with that unit).
function mapFieldWork({ text, lines, crewHours, estimateItems, team, selfMemberId, selfCrew, anyCrew }) {
  const items = estimateItems || [];
  const recorded = [];
  const unmatched = [];
  const structured = Array.isArray(lines) ? lines : [];
  for (const line of structured) {
    const item = findEstimateItem(items, line.estimateItemId ?? line.name);
    const quantity = line.quantity == null || line.quantity === '' ? null : Number(line.quantity);
    if (!item || !Number.isFinite(quantity) || quantity < 0) {
      const label = line.name || line.estimateItemId || 'that line';
      unmatched.push(quantity != null && Number.isFinite(Number(quantity)) ? `${quantity} ${line.unit || ''} ${label}`.replace(/\s+/g, ' ').trim() : String(label));
      continue;
    }
    recorded.push({ item, quantity: round(quantity), laborHours: Math.min(24, Math.max(0, Number(line.laborHours) || 0)) });
  }
  if (!structured.length && String(text || '').trim()) {
    const proposed = dailyWork.propose(text);
    if (!proposed.length) unmatched.push(String(text).trim());
    for (const row of proposed) {
      const proposal = dailyWork.scopeProposal({ description: row.description, quantity: row.quantity, unit: row.unit }, items);
      let item = proposal.mode === 'estimate' ? findEstimateItem(items, proposal.estimateItemId) : null;
      if (!item && row.quantity != null && row.unit) item = uniqueUnitItem(items, row.unit);
      if (item && row.quantity != null && Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= 0) recorded.push({ item, quantity: round(row.quantity), laborHours: 0 });
      else unmatched.push(row.description || String(text).trim());
    }
  }
  const labor = [];
  const suppliedHours = Array.isArray(crewHours) ? crewHours : [];
  for (const row of suppliedHours) {
    const hours = Number(row.hours);
    const member = crewMember(team, selfMemberId, selfCrew, row, anyCrew);
    if (!member || !Number.isFinite(hours) || hours < 0 || hours > 24) {
      unmatched.push(`Hours not recorded${row.name || row.memberId ? ` for ${row.name || row.memberId}` : ''}.`);
      continue;
    }
    labor.push({ member, hours: round(hours) });
  }
  if (!suppliedHours.length) {
    const hours = parseOwnHours(text);
    const member = (team || []).find(person => Number(person.id) === Number(selfMemberId));
    if (hours != null && member) labor.push({ member, hours });
  }
  return { recorded, unmatched, labor };
}

function mergeProduction(existing, recorded) {
  const entries = (existing || []).map(entry => ({ ...entry }));
  for (const row of recorded) {
    const found = entries.find(entry => String(entry.estimateItemId) === String(row.item.id));
    if (found) found.quantity = round((Number(found.quantity) || 0) + row.quantity);
    else entries.push({ estimateItemId: row.item.id, description: row.item.name, quantity: row.quantity, unit: row.item.unit || '', laborHours: 0 });
  }
  return entries;
}

function mergeLabor(existing, labor, team) {
  const entries = (existing || []).map(entry => ({ ...entry }));
  for (const row of labor) {
    const found = entries.find(entry => Number(entry.memberId) === Number(row.member.id));
    if (found) found.hours = round((Number(found.hours) || 0) + row.hours);
    else entries.push({ memberId: row.member.id, hours: row.hours, crew: row.member.crew || (team || []).find(member => Number(member.id) === Number(row.member.id))?.crew || 'Unassigned' });
  }
  return entries;
}

function balanceHours(entries, laborEntries) {
  const crew = round(laborEntries.reduce((sum, row) => sum + (Number(row.hours) || 0), 0));
  if (entries.length === 1 && crew > 0) entries[0].laborHours = crew;
  const allocated = round(entries.reduce((sum, row) => sum + (Number(row.laborHours) || 0), 0));
  return { entries, balanced: Math.abs(allocated - crew) < 0.01, crewHours: crew, allocatedHours: allocated };
}

function appendNote(existing, text) {
  const next = String(text || '').trim();
  const prior = String(existing || '').trim();
  if (!next) return prior.slice(0, 8000);
  if (!prior) return next.slice(0, 8000);
  if (prior.includes(next)) return prior.slice(0, 8000);
  return `${prior}\n\n${next}`.slice(0, 8000);
}

module.exports = { mapFieldWork, mergeProduction, mergeLabor, balanceHours, appendNote, canonicalUnit, findEstimateItem };
