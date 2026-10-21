'use strict';

const path = require('node:path');
const supabase = require('./supabase');
const {
  parseArgs,
  execute,
  sanitizedResult,
  sanitizedFailure
} = require('./legacy-normalized-artifact-quarantine');

const processAbortController = new AbortController();

function interrupt() {
  if (processAbortController.signal.aborted) return;
  processAbortController.abort();
  process.exitCode = 130;
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseArgs(argv);
  const result = await execute(args, env, {
    ...dependencies,
    signal: dependencies.signal || processAbortController.signal
  });
  (dependencies.stdout || process.stdout).write(`${JSON.stringify(sanitizedResult(result), null, 2)}\n`);
  return result;
}

if (require.main === module) {
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  main().catch(error => {
    process.stderr.write(`${JSON.stringify(sanitizedFailure(error))}\n`);
    process.exitCode = error?.code === 'INTERRUPTED' ? 130 : 2;
  });
}

module.exports = { main };
