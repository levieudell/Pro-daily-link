const path = require('node:path');
const supabase = require('./supabase');

const root = path.resolve(__dirname, '..');
supabase.loadLocalEnv(root);
process.env.PDL_SUPABASE_ENABLED ||= '1';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const email = argument('email').trim().toLowerCase();
  const accountType = argument('type', 'standard');
  if (!email || !['standard', 'early_adopter', 'legacy'].includes(accountType)) {
    throw new Error('Use --email user@example.com --type standard|early_adopter|legacy');
  }
  if (!supabase.configured()) throw new Error('Supabase is not configured');
  const companyId = await supabase.findCompanyByUserEmail(email);
  if (!companyId) throw new Error('No active company account found for that email');
  const snapshot = await supabase.loadCompanySnapshot(companyId);
  if (!snapshot?.company) throw new Error('Company snapshot could not be loaded');

  snapshot.company.accountType = accountType;
  snapshot.company.billingExempt = argument('exempt', 'false') === 'true';
  snapshot.company.cohort = argument('cohort').slice(0, 80);
  snapshot.company.discountPercent = Math.min(100, Math.max(0, Number(argument('discount', '0')) || 0));
  snapshot.company.planPrice = Math.max(0, Number(argument('price', String(snapshot.company.planPrice || 0))) || 0);
  snapshot.company.commercialNote = argument('note').slice(0, 500);
  snapshot.company.commercialUpdatedAt = new Date().toISOString();
  await supabase.saveCompanySnapshot(snapshot);

  console.log(JSON.stringify({
    ok: true,
    companyId,
    company: snapshot.company.name,
    accountType: snapshot.company.accountType,
    billingExempt: snapshot.company.billingExempt,
    cohort: snapshot.company.cohort,
    discountPercent: snapshot.company.discountPercent,
    planPrice: snapshot.company.planPrice
  }, null, 2));
}

main().catch(error => {
  console.error(`Commercial account update failed: ${error.message}`);
  process.exitCode = 1;
});
