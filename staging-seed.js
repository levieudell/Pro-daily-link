'use strict';
// Staging JSON store for PDL_STAGING=1.
// Passwords come from PDL_STAGING_OWNER_PASSWORD and PDL_STAGING_FIELD_PASSWORD.
// Notes parsing uses OPENAI_API_KEY when that variable is set. OPENAI_MODEL is
// optional and defaults to gpt-5.4-mini. Without OPENAI_API_KEY the local
// parser still fills the daily from the notes.
// IndexNow is not implemented in this app. Staging sends X-Robots-Tag: noindex
// and drops INDEXNOW_KEY if a host sets it. The store is rewritten on each boot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COMPANY_ID = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const COMPANY_NAME = 'DEMO | Alder Ridge Builders';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const TIMEZONE = 'America/Los_Angeles';

function stagingToday(now = new Date(), timezone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addIsoDays(iso, days) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function passwordOrThrow(env, key) {
  const value = String(env?.[key] || '');
  if (value.length < 10) throw new Error(`${key} must be at least 10 characters`);
  return value;
}

function credential(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(value, salt, 64).toString('hex') };
}

function buildStagingDb(env = process.env, now = new Date()) {
  const ownerPassword = passwordOrThrow(env, 'PDL_STAGING_OWNER_PASSWORD');
  const fieldPassword = passwordOrThrow(env, 'PDL_STAGING_FIELD_PASSWORD');
  const today = stagingToday(now);
  const tomorrow = addIsoDays(today, 1);
  const createdAt = now.toISOString();
  const ownerCred = credential(ownerPassword);
  const fieldCred = credential(fieldPassword);
  const clinicItems = [
    { id: 1, name: 'Curb', plannedQuantity: 800, unit: 'LF', budgetHours: 80, cost: 24000 },
    { id: 2, name: 'Slab on grade', plannedQuantity: 12000, unit: 'SF', budgetHours: 480, cost: 144000 },
    { id: 3, name: 'Footings', plannedQuantity: 240, unit: 'CY', budgetHours: 240, cost: 72000 },
    { id: 4, name: 'Sidewalk', plannedQuantity: 400, unit: 'SF', budgetHours: 40, cost: 12000 }
  ];
  const projects = [
    {
      id: 1, customerId: 1, name: 'DEMO Riverbend Subdivision Phase 2', customer: 'DEMO Riverbend Development', code: 'D-RB2', color: '#dcebe4', site: '17875 SW Farmington Rd, Beaverton, OR 97005', crew: 2, progress: 0, production: 0, status: 'On track', budget: '$125K', contractType: 'estimated', startDate: today, endDate: addIsoDays(today, 28), supervisor: 'DEMO Sam Ortiz', siteContact: 'DEMO Dana Whitfield',
      estimateItems: [
        { id: 1, name: 'Mass excavation', plannedQuantity: 2000, unit: 'CY', budgetHours: 160, cost: 96000 },
        { id: 2, name: 'Structural fill', plannedQuantity: 1200, unit: 'CY', budgetHours: 96, cost: 28800 }
      ]
    },
    {
      id: 2, customerId: 2, name: 'DEMO Hwy 99 Waterline Replacement', customer: 'DEMO Cascade Water District', code: 'D-HW9', color: '#e6e1f2', site: '12950 SW Pacific Hwy, Tigard, OR 97223', crew: 2, progress: 0, production: 0, status: 'On track', budget: '$132K', contractType: 'estimated', startDate: today, endDate: addIsoDays(today, 28), supervisor: 'DEMO Riley Brooks', siteContact: 'DEMO Pat Cervantes',
      estimateItems: [
        { id: 1, name: 'Trench excavation & backfill', plannedQuantity: 1500, unit: 'LF', budgetHours: 300, cost: 90000 },
        { id: 2, name: '8" DI pipe install', plannedQuantity: 1400, unit: 'LF', budgetHours: 140, cost: 42000 }
      ]
    },
    {
      id: 3, customerId: 3, name: 'DEMO Cedar Grove Clinic', customer: 'DEMO Cedar Grove Holdings', code: 'D-CGC', color: '#e9e3d6', site: '1840 SW Cedar Grove Dr, Beaverton, OR 97005', crew: 3, progress: 0, production: 0, status: 'On track', budget: '$252K', contractType: 'estimated', startDate: today, endDate: addIsoDays(today, 28), supervisor: 'DEMO Jordan Reed', siteContact: 'DEMO Riley Osei',
      estimateItems: clinicItems
    }
  ];
  const team = [
    { id: 1, name: 'DEMO Jordan Reed', role: 'Finisher', initials: 'JR', crew: 'Concrete', hours: 8, site: 'DEMO Cedar Grove Clinic', phone: '(503) 555-0171', email: FIELD_EMAIL },
    { id: 2, name: 'DEMO Casey Nguyen', role: 'Laborer', initials: 'CN', crew: 'Concrete', hours: 8, site: 'DEMO Cedar Grove Clinic', phone: '(503) 555-0172', email: 'crew-casey@alder-ridge.example' },
    { id: 3, name: 'DEMO Alex Mora', role: 'Laborer', initials: 'AM', crew: 'Concrete', hours: 8, site: 'DEMO Cedar Grove Clinic', phone: '(503) 555-0173', email: 'crew-alex@alder-ridge.example' },
    { id: 4, name: 'DEMO Sam Ortiz', role: 'Operator', initials: 'SO', crew: 'Dirt', hours: 8, site: 'DEMO Riverbend Subdivision Phase 2', phone: '(503) 555-0174', email: 'crew-sam@alder-ridge.example' },
    { id: 5, name: 'DEMO Riley Brooks', role: 'Operator', initials: 'RB', crew: 'Pipe', hours: 8, site: 'DEMO Hwy 99 Waterline Replacement', phone: '(503) 555-0175', email: 'crew-riley@alder-ridge.example' },
    { id: 10, name: 'DEMO Avery Lang', role: 'Account Owner', initials: 'AL', crew: 'Office', hours: 0, site: 'Not assigned', phone: '(503) 555-0100', email: OWNER_EMAIL }
  ];
  const userBase = { status: 'Active', projectIds: [], mustSetPassword: false, preferredLanguage: 'en', emailVerifiedAt: createdAt, createdAt };
  const assignments = [];
  const pushAssignment = (projectId, memberIds, crew, date, activity) => {
    assignments.push({ id: assignments.length + 1, projectId, memberIds, crew, date, start: '07:00', end: '15:30', activity, acknowledgements: {} });
  };
  for (const date of [today, tomorrow]) {
    pushAssignment(1, [4], 'Dirt', date, 'DEMO: Mass excavation');
    pushAssignment(2, [5], 'Pipe', date, 'DEMO: Waterline trench');
    pushAssignment(3, [1, 2, 3], 'Concrete', date, 'DEMO: Curb, footings, and slab');
  }
  return {
    company: {
      id: COMPANY_ID,
      name: COMPANY_NAME,
      demo: true,
      staging: true,
      billingExempt: true,
      subscriptionStatus: 'Demo',
      accountType: 'standard',
      plan: 'pro',
      planPrice: 0,
      trade: 'Excavation, utilities, and concrete',
      email: OWNER_EMAIL,
      phone: '(503) 555-0100',
      timezone: TIMEZONE,
      weekStart: 'monday',
      features: { timeCards: true, templates: false },
      commercialNote: 'Staging demo. Data resets on each deploy. No Stripe customer or outbound email.',
      createdAt
    },
    users: [
      { id: 1, companyId: COMPANY_ID, name: 'DEMO Avery Lang', email: OWNER_EMAIL, role: 'owner', memberId: 10, ...userBase, ...ownerCred },
      { id: 2, companyId: COMPANY_ID, name: 'DEMO Jordan Reed', email: FIELD_EMAIL, role: 'field', memberId: 1, ...userBase, ...fieldCred }
    ],
    sessions: [],
    customers: [
      { id: 1, name: 'DEMO Riverbend Development', contact: 'DEMO Dana Whitfield', email: 'customer-1@alder-ridge.example', phone: '(503) 555-0101' },
      { id: 2, name: 'DEMO Cascade Water District', contact: 'DEMO Pat Cervantes', email: 'customer-2@alder-ridge.example', phone: '(503) 555-0102' },
      { id: 3, name: 'DEMO Cedar Grove Holdings', contact: 'DEMO Riley Osei', email: 'customer-3@alder-ridge.example', phone: '(503) 555-0103' }
    ],
    projects,
    team,
    crews: [
      { id: 1, name: 'Concrete', createdAt },
      { id: 2, name: 'Dirt', createdAt },
      { id: 3, name: 'Pipe', createdAt },
      { id: 4, name: 'Office', createdAt }
    ],
    catalog: [],
    reports: [],
    assignments,
    timeCards: [],
    workdays: [],
    payPeriods: [],
    photos: [],
    changes: [],
    subcontractors: [],
    subcontractorLinks: [],
    auditLog: []
  };
}

function ensureStagingDatabase(file, env = process.env, now = new Date()) {
  const db = buildStagingDb(env, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
  return db;
}

module.exports = { COMPANY_ID, COMPANY_NAME, OWNER_EMAIL, FIELD_EMAIL, TIMEZONE, stagingToday, addIsoDays, buildStagingDb, ensureStagingDatabase };
