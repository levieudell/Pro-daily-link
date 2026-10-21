'use strict';

const path = require('node:path');
const {
  inspectMaintenanceFence,
  publicFenceState,
  openMaintenanceFence,
  closeMaintenanceFence
} = require('./maintenance-fence');

function parseArgs(argv = process.argv.slice(2)) {
  const action = argv[0];
  if (!['open', 'status', 'close'].includes(action)) throw new Error('Choose one action: open, status, or close.');
  const output = {
    action,
    apply: false,
    transition: false,
    expectedDigest: '',
    expectedServiceId: '',
    expectedInstanceId: '',
    expectedReleaseSha: '',
    lockFile: ''
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--apply') { output.apply = true; continue; }
    if (argument === '--transition') { output.transition = true; continue; }
    const key = {
      '--expected-digest': 'expectedDigest',
      '--expected-service-id': 'expectedServiceId',
      '--expected-instance-id': 'expectedInstanceId',
      '--expected-release-sha': 'expectedReleaseSha',
      '--lock-file': 'lockFile'
    }[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    output[key] = value;
    index += 1;
  }
  if (output.lockFile && !path.isAbsolute(output.lockFile)) throw new Error('--lock-file must be an absolute path.');
  if (action === 'status' && (output.apply || output.transition || output.expectedDigest)) throw new Error('status does not accept apply, transition, or expected digest arguments.');
  if (action === 'open' && output.expectedDigest) throw new Error('open does not accept --expected-digest.');
  if (action !== 'open' && output.transition) throw new Error('--transition is only valid with open.');
  if (action === 'close' && (!output.apply || !output.expectedDigest)) {
    throw new Error('close requires --apply and --expected-digest.');
  }
  if (action === 'open' && !output.apply) throw new Error('open requires --apply.');
  return output;
}

function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseArgs(argv);
  let result;
  if (options.action === 'open') result = openMaintenanceFence(env, options);
  else if (options.action === 'close') result = closeMaintenanceFence(env, options);
  else result = publicFenceState(inspectMaintenanceFence(env, options));
  const output = { schema: 'pdl-maintenance-lock-cli/v1', action: options.action, ...result };
  (dependencies.stdout || process.stdout).write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const reason = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : error instanceof Error && /^(?:Choose one|Unknown argument|Duplicate argument|open |close |status |--)/.test(error.message)
        ? 'INVALID_ARGUMENT'
        : 'MAINTENANCE_COMMAND_FAILED';
    process.stderr.write(`${JSON.stringify({ schema: 'pdl-maintenance-lock-cli/v1', status: 'failed', reason })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, main };
