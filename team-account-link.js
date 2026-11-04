"use strict";
const { randomUUID } = require("node:crypto");
// Linking is explicit and only joins an unlinked login to a unique email match.
function linkTeamAccount(db, actor, userId, memberId, now = new Date().toISOString()) {
  const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!actor) fail(401, 'Sign in to link a login.');
  if (actor.role !== 'owner') fail(403, 'Only the account owner can link a login.');
  const user = (db.users || []).find(row => Number(row.id) === Number(userId));
  const member = (db.team || []).find(row => Number(row.id) === Number(memberId));
  if (!user || !member) fail(404, 'Login or team member not found.');
  const email = value => String(value || '').trim().toLowerCase();
  const address = email(member.email);
  if (!address || address !== email(user.email)) fail(400, 'The login and team member must have the same email.');
  if ((db.team || []).filter(row => email(row.email) === address).length !== 1 ||
      (db.users || []).filter(row => email(row.email) === address).length !== 1)
    fail(409, 'More than one record uses this email. Correct the contact details before linking.');
  if (user.memberId && Number(user.memberId) !== Number(member.id)) fail(409, 'This login is already linked to another team member.');
  if ((db.users || []).some(row => row !== user && Number(row.memberId) === Number(member.id))) fail(409, 'This team member already has a linked login.');
  if (Number(user.memberId) === Number(member.id)) return user;
  const before = { memberId: user.memberId || null };
  user.memberId = member.id;
  user.updatedAt = now;
  (db.auditLog ||= []).push({ id: randomUUID(), type: 'team_login_linked', userId: user.id, memberId: member.id,
    actor: actor.name, actorId: actor.id, at: now, before, after: { memberId: member.id },
    detail: `${user.name}: existing login linked to ${member.name}; access unchanged` });
  return user;
}
module.exports = { linkTeamAccount };
