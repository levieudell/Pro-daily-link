'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const seed = require('./staging-seed');

const ownerPassword = 'staging-owner-pass';
const fieldPassword = 'staging-field-pass';
const env = { PDL_STAGING_OWNER_PASSWORD: ownerPassword, PDL_STAGING_FIELD_PASSWORD: fieldPassword };
const now = new Date('2026-10-16T15:00:00.000Z');
const db = seed.buildStagingDb(env, now);
const today = seed.stagingToday(now);

assert.equal(db.company.id, '7176abe8-07e4-4336-a372-1163d2f21ff9');
assert.equal(db.company.name, 'DEMO | Alder Ridge Builders');
assert.equal(db.company.demo, true);
assert.equal(db.company.billingExempt, true);
assert.equal(db.company.subscriptionStatus, 'Demo');
assert.equal(db.company.stripeCustomerId, undefined);
assert.equal(db.company.stripeSubscriptionId, undefined);
assert.equal(db.projects.length, 3);

const clinic = db.projects.find(project => project.code === 'D-CGC');
assert.equal(clinic.name, 'DEMO Cedar Grove Clinic');
assert.ok(clinic.estimateItems.some(item => item.name === 'Curb' && item.unit === 'LF'));
assert.ok(clinic.estimateItems.some(item => item.name === 'Slab on grade' && item.unit === 'SF'));
assert.ok(clinic.estimateItems.some(item => item.unit === 'CY'));

const jordan = db.team.find(member => member.name === 'DEMO Jordan Reed');
assert.equal(jordan.email, 'levi+field@prodailylink.com');
assert.equal(jordan.crew, 'Concrete');
const fieldUser = db.users.find(user => user.email === 'levi+field@prodailylink.com');
assert.equal(fieldUser.role, 'field');
assert.equal(fieldUser.memberId, jordan.id);
assert.equal(fieldUser.mustSetPassword, false);
assert.ok(fieldUser.emailVerifiedAt);
const owner = db.users.find(user => user.email === 'levi+owner@prodailylink.com');
assert.equal(owner.role, 'owner');

const clinicToday = db.assignments.filter(row => row.projectId === clinic.id && row.date === today);
assert.ok(clinicToday.some(row => row.memberIds.includes(jordan.id)), 'today has Jordan on Cedar Grove');
assert.ok(db.assignments.some(row => row.projectId === clinic.id && row.date === seed.addIsoDays(today, 1)));
assert.ok(db.projects.every(project => db.assignments.some(row => row.projectId === project.id && row.date === today)));

const serialized = JSON.stringify(db);
assert.equal(serialized.includes(ownerPassword), false);
assert.equal(serialized.includes(fieldPassword), false);
for (const user of db.users) {
  const password = user.email === owner.email ? ownerPassword : fieldPassword;
  assert.equal(crypto.scryptSync(password, user.passwordSalt, 64).toString('hex'), user.passwordHash);
}

assert.throws(() => seed.buildStagingDb({ PDL_STAGING_FIELD_PASSWORD: fieldPassword }), /PDL_STAGING_OWNER_PASSWORD/);
assert.throws(() => seed.buildStagingDb({ PDL_STAGING_OWNER_PASSWORD: 'short', PDL_STAGING_FIELD_PASSWORD: fieldPassword }), /at least 10/);

const file = path.join(os.tmpdir(), `pdl-staging-${process.pid}.json`);
seed.ensureStagingDatabase(file, env, now);
const written = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(written.company.id, db.company.id);
fs.unlinkSync(file);

const server = fs.readFileSync(__dirname + '/server.js', 'utf8');
assert.match(server, /ensureStagingDatabase\(DB_FILE/);
assert.match(server, /delete process\.env\[key\]/);
assert.match(server, /INDEXNOW_KEY/);
assert.match(server, /staging:process\.env\.PDL_STAGING==='1'/);
const source = fs.readFileSync(__dirname + '/staging-seed.js', 'utf8');
assert.match(source, /OPENAI_API_KEY/);
assert.equal(source.includes(ownerPassword), false);
const indexHtml = fs.readFileSync(__dirname + '/index.html', 'utf8');
const loginHtml = fs.readFileSync(__dirname + '/login.html', 'utf8');
const stagingBanner = fs.readFileSync(__dirname + '/staging-banner.js', 'utf8');
assert.match(indexHtml, /src="staging-banner\.js"/);
assert.match(loginHtml, /src="staging-banner\.js"/);
assert.match(stagingBanner, /config\.staging/);
assert.match(stagingBanner, /STAGING/);

console.log('Staging seed checks passed.');
