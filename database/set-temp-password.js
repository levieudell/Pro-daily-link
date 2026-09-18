const crypto = require('node:crypto');
const path = require('node:path');
const supabase = require('./supabase');

const root = path.resolve(__dirname, '..');
supabase.loadLocalEnv(root);
process.env.PDL_SUPABASE_ENABLED ||= '1';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function main() {
  const email = argument('email').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Use --email user@example.com');
  if (!supabase.configured()) throw new Error('Supabase is not configured');

  const companyId = await supabase.findCompanyByUserEmail(email);
  if (!companyId) throw new Error('No active company account found for that email');
  const snapshot = await supabase.loadCompanySnapshot(companyId);
  const user = (snapshot?.users || []).find(row => row.status === 'Active' && String(row.email || '').toLowerCase() === email);
  if (!snapshot?.company || !user) throw new Error('Active user account could not be loaded');

  const temporaryPassword = crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  user.setupHash = crypto.scryptSync(temporaryPassword, salt, 64).toString('hex');
  user.setupSalt = salt;
  user.setupExpiresAt = new Date(Date.now() + 72 * 3600000).toISOString();
  user.mustSetPassword = true;
  delete user.passwordHash;
  delete user.passwordSalt;
  snapshot.sessions = (snapshot.sessions || []).filter(row => row.userId !== user.id);
  await supabase.saveCompanySnapshot(snapshot);

  console.log(JSON.stringify({
    ok: true,
    company: snapshot.company.name,
    email,
    temporaryPassword,
    expiresAt: user.setupExpiresAt
  }, null, 2));
}

main().catch(error => {
  console.error(`Temporary password update failed: ${error.message}`);
  process.exitCode = 1;
});
