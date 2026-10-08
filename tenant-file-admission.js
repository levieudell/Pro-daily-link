'use strict';
const fs = require('node:fs');
// Explicit shared-file mode only. Atomic mkdir is the cross-process admission
// point; every tenant request uses it. Never expire/steal a live writer's lease.
async function withAdmission(file, enabled, task) {
  if (!enabled) return task();
  const lock = file + '.admission-lock', deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      if (Date.now() >= deadline) throw Object.assign(new Error('Tenant admission is busy. Retry after the active request finishes.'), { statusCode: 503 });
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  try { return await task(); } finally { fs.rmdirSync(lock); }
}
module.exports = { withAdmission };
