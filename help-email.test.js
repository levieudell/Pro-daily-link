'use strict';
const assert=require('node:assert/strict'),email=require('./help-email');
const key='SyntheticUnsubscribeKeyForLocalTestsOnly42',day='2026-10-08';
const user={id:1,role:'owner',status:'Active',companyId:'synthetic',email:'owner@example.invalid',emailVerifiedAt:'2026-10-01',helpGuidance:{emailTips:true,inApp:false}},db={company:{id:'synthetic'},users:[user],projects:[],team:[],reports:[]};
const token=email.tokenFor(db,user,key),payload=email.verifyToken(token,key);assert.ok(payload);assert.equal(email.verifyToken(token+'x',key),null);assert.equal(email.verifyToken(token,'wrong'),null);
const first=email.reserve(db,user,'project',day);assert.ok(first);assert.equal(first.duplicate,false);assert.equal(email.recheck(db,first.receipt,day),true);
user.companyId='other';assert.equal(email.recheck(db,first.receipt,day),false);user.companyId='synthetic';assert.equal(email.recheck(db,first.receipt,'2026-10-09'),false,'stale reservations cannot bypass daily cadence');
// Reservation hides attempted tips; repeated reserve for its old ID returns no send candidate.
assert.equal(email.reserve(db,user,'project',day).duplicate,true);assert.equal(db.helpEmailReceipts.length,1);
assert.equal(email.reserve(db,user,'crew',day),null,'daily cadence');
email.recordOutcome(db,first.receipt.key,'unknown');assert.equal(email.recheck(db,first.receipt,day),false);assert.equal(email.reserve(db,user,'project','2026-10-09').duplicate,true,'unknown outcomes never automatically resend');
const second=email.reserve(db,user,'crew','2026-10-09');assert.ok(second);assert.equal(email.unsubscribe(db,payload),true);assert.equal(second.receipt.status,'cancelled');assert.equal(user.helpGuidance.emailTips,false);assert.equal(email.unsubscribe(db,payload),true,'idempotent unsubscribe');assert.equal(email.reserve(db,user,'daily','2026-10-10'),null);
assert.equal(email.unsubscribe({...db,company:{id:'other'}},payload),false);
assert.throws(()=>email.headers('http://example.invalid/unsubscribe'));assert.equal(email.headers('https://example.invalid/unsubscribe')['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
user.helpGuidance.emailTips=true;user.role='field';assert.equal(email.reserve(db,user,'daily','2026-10-10'),null);user.role='owner';user.emailVerifiedAt=null;assert.equal(email.reserve(db,user,'daily','2026-10-10'),null);
const completed={...db,projects:[{id:1}],team:[{crew:'A'}],reports:[{status:'Approved'}]};user.emailVerifiedAt=day;assert.equal(email.reserve(completed,user,'daily','2026-10-10'),null);
console.log('Disabled Help email tests passed: consent/role/verification/completion checks, unique reservations, daily/lifetime caps, unknown outcomes, signed tenant/recipient unsubscribe and one-click headers. No delivery adapter.');
