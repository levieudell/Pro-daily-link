const assert=require('node:assert');
const fs=require('node:fs');

const app=fs.readFileSync('app.js','utf8');

assert.match(app,/Saved on this device · protected if you refresh/,'autosave copy must accurately describe device storage');
assert.match(app,/pdl-active-report-recovery-v1/,'an interrupted report marker must be persisted');
assert.match(app,/restoreInterruptedReport\(\)/,'interrupted reports must be restored during workspace loading');
assert.match(app,/openReport\(saved\|\|null\)/,'both existing drafts and new reports must reopen after refresh');
assert.match(app,/reportRecoverySnapshot\(\)/,'the complete in-progress report state must be captured');
assert.match(app,/restoreRecoveredReportFields\(draft\)/,'dates, detail fields, labor, and production must be restored');
assert.match(app,/Reattach .*photo/,'non-restorable browser file selections must be disclosed');
assert.ok(app.includes('clearActiveReportRecovery(`report-${saved.id}`)'), 'confirmed core saves clear recovered browser data');
assert.match(app,/levi\\\+qa-/,'known QA audit records must be hidden from the customer-facing activity log');
assert.doesNotMatch(app,/\#autosave-status'\)\.textContent='Draft saved just now'(?=[^\n]*rememberActiveReport)/,'the recovery layer must not claim that device-only notes are a server draft');

console.log('Daily report recovery tests passed');
