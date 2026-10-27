'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

function main() {
  const root = lib.artifactsRoot();
  const runFile = path.join(root, 'run.json');
  let killed = false;
  if (fs.existsSync(runFile)) {
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    if (run.browserPid) {
      try {
        process.kill(run.browserPid, 'SIGTERM');
        killed = true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      run.browserPid = null;
      run.cleanedAt = new Date().toISOString();
      lib.writeJson(runFile, run);
    }
  }
  const evidenceKept = fs.existsSync(root);
  process.stdout.write(`${JSON.stringify({ cleaned: true, killedBrowser: killed, artifacts: root, evidenceKept })}\n`);
}

main();
