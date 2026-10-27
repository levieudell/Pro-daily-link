'use strict';

const assert = require('node:assert/strict');

Object.assign(process.env, {
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SECRET_KEY: 'test-only',
  PDL_TRANSACTIONAL_DB: 'primary'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
const removed = [];
supabase.configured = () => true;
supabase.remove = async (bucket, objectKey) => { removed.push([bucket, objectKey]); return true; };

const { guardStoredAssetCommit, removeStoredAsset } = require('./server');
const companyId = '11111111-1111-4111-8111-111111111111';
const db = { company: { id: companyId, name: 'Storage compensation QA' } };

(async () => {
  const original = Object.assign(new Error('authoritative save failed'), { code: 'PDL_REVISION_CONFLICT' });
  const pending = Promise.reject(original);
  const context = { transactionalPending: pending, pending: [pending] };
  const assets = [
    { bucket: 'project-photos', objectKey: `${companyId}/first.jpg` },
    { bucket: 'project-photos', objectKey: `${companyId}/second.jpg` }
  ];

  assert.equal(guardStoredAssetCommit(context, db, assets), true);
  await assert.rejects(context.pending[0], error => error === original);
  assert.deepEqual(removed, [
    ['project-photos', `${companyId}/second.jpg`],
    ['project-photos', `${companyId}/first.jpg`]
  ], 'failed database commits remove every newly uploaded object in reverse order');
  assert.equal(context.transactionalPending, context.pending[0], 'later transactional work chains from the guarded commit');

  const missing = Object.assign(new Error('already gone'), { statusCode: 404 });
  supabase.remove = async () => { throw missing; };
  await assert.doesNotReject(() => removeStoredAsset(db, assets[0]), 'cleanup is idempotent when storage already removed the object');
  await assert.rejects(
    () => removeStoredAsset(db, { bucket: 'project-photos', objectKey: 'another-tenant/photo.jpg' }),
    /unsafe stored asset/,
    'compensation cannot delete another tenant\'s object'
  );

  const cleanupFailure = new Error('storage temporarily unavailable');
  supabase.remove = async () => { throw cleanupFailure; };
  const secondOriginal = new Error('database commit still failed');
  const secondPending = Promise.reject(secondOriginal);
  const secondContext = { transactionalPending: secondPending, pending: [secondPending] };
  const priorError = console.error;
  console.error = () => {};
  try {
    guardStoredAssetCommit(secondContext, db, [assets[0]]);
    await assert.rejects(secondContext.pending[0], error => error === secondOriginal);
  } finally {
    console.error = priorError;
  }

  console.log('stored asset compensation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
