'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_MS = 36 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const milliseconds = value => typeof value === 'string' ? Date.parse(value) : NaN;
const inFlight = new Map();

function receiptFile(directory, companyId) {
  if (!companyId || !directory) throw new Error('Backup verification requires a tenant and private directory.');
  return path.join(directory, digest(Buffer.from(String(companyId))) + '.json');
}

function validVerification(value, companyId, now) {
  const time = milliseconds(value?.verifiedAt);
  return value?.method === 'upload-download-sha256' && Number.isFinite(time) && time <= now &&
    value.bucket === 'tenant-backups' && typeof value.objectKey === 'string' &&
    value.objectKey.startsWith(String(companyId) + '/') && !value.objectKey.includes('..') &&
    /^[a-f0-9]{64}$/.test(value.sha256 || '') && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 0;
}

function readReceipt(directory, companyId, now = Date.now()) {
  try {
    const value = JSON.parse(fs.readFileSync(receiptFile(directory, companyId), 'utf8'));
    if (value.version !== 1 || value.companyId !== String(companyId)) return null;
    const attemptTime = milliseconds(value.attempt?.at);
    const attempt = Number.isFinite(attemptTime) && attemptTime <= now &&
      ['pending', 'verified', 'failed'].includes(value.attempt.status) ? value.attempt : null;
    return { version: 1, companyId: String(companyId), attempt,
      verification: validVerification(value.verification, companyId, now) ? value.verification : null };
  } catch {
    // Missing, corrupt or inaccessible receipts never establish successful verification.
    return null;
  }
}

function writeReceipt(directory, companyId, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = receiptFile(directory, companyId), temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function backupDue(directory, companyId, now = Date.now()) {
  if (inFlight.has(receiptFile(directory, companyId))) return false;
  const receipt = readReceipt(directory, companyId, now);
  const verifiedAt = milliseconds(receipt?.verification?.verifiedAt);
  if (Number.isFinite(verifiedAt) && now - verifiedAt < BACKUP_INTERVAL_MS) return false;
  const attemptedAt = milliseconds(receipt?.attempt?.at);
  // Retry failed/interrupted checks on a later write, without a 24-hour false-success delay
  // or issuing an upload for every write during a provider outage.
  return !Number.isFinite(attemptedAt) || now - attemptedAt >= RETRY_AFTER_MS;
}

function publicStatus(directory, companyId, now = Date.now()) {
  const receipt = readReceipt(directory, companyId, now);
  const lastVerifiedAt = receipt?.verification?.verifiedAt || null;
  return {
    scope: 'single-tenant-snapshot',
    lastAttemptAt: receipt?.attempt?.at || null,
    lastAttemptStatus: receipt?.attempt?.status || null,
    lastVerifiedAt,
    fresh: Boolean(lastVerifiedAt && now - milliseconds(lastVerifiedAt) < FRESHNESS_MS),
    independentCopy: 'not-checked',
    restore: 'not-checked'
  };
}

function completeAttempt(directory, companyId, attempt, verification, previous, now) {
  // A failed application save can release its tenant queue before an older backup settles.
  // Preserve evidence from any newer receipt, including across an interrupted process.
  const current = readReceipt(directory, companyId, now);
  let newest = current?.verification || previous?.verification || null;
  if (verification && (!newest || milliseconds(verification.verifiedAt) > milliseconds(newest.verifiedAt) ||
      milliseconds(verification.verifiedAt) === milliseconds(newest.verifiedAt) && verification.sourceRevision >= newest.sourceRevision)) {
    newest = verification;
  }
  const newerAttempt = current?.attempt && current.attempt.id !== attempt.id &&
    milliseconds(current.attempt.at) >= milliseconds(attempt.at);
  writeReceipt(directory, companyId, { version: 1, companyId,
    attempt: newerAttempt ? current.attempt : attempt, verification: newest });
}

async function runVerification(snapshot, { directory, createBackup, now = () => Date.now() }) {
  const companyId = String(snapshot?.company?.id || '');
  const attemptedAt = new Date(now()).toISOString();
  const previous = readReceipt(directory, companyId, now());
  const attempt = { id: crypto.randomUUID(), at: attemptedAt, status: 'pending' };
  const receipt = { version: 1, companyId, attempt,
    verification: previous?.verification || null };
  writeReceipt(directory, companyId, receipt);
  try {
    // createBackup must complete its upload, download and hash comparison before returning.
    const result = await createBackup(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const completedAt = now();
    const verification = {
      method: 'upload-download-sha256', verifiedAt: result?.verifiedAt,
      bucket: result?.bucket, objectKey: result?.objectKey, sha256: result?.hash,
      bytes: result?.bytes, sourceRevision: Number(snapshot.company.persistence?.revision || 0)
    };
    if (!validVerification(verification, companyId, completedAt) ||
        milliseconds(verification.verifiedAt) < milliseconds(attemptedAt) ||
        verification.sha256 !== digest(bytes) || verification.bytes !== bytes.length) {
      throw new Error('Backup verification result does not match the captured snapshot.');
    }
    completeAttempt(directory, companyId, { ...attempt, status: 'verified' }, verification, previous, completedAt);
    return result;
  } catch (error) {
    // Preserve the previous real success; a failed attempt never advances its timestamp.
    completeAttempt(directory, companyId, { ...attempt, status: 'failed' }, null, previous, now());
    throw error;
  }
}

function createAndRecordVerification(snapshot, options) {
  const key = receiptFile(options.directory, snapshot?.company?.id);
  if (inFlight.has(key)) return inFlight.get(key);
  const running = runVerification(snapshot, options).finally(() => {
    if (inFlight.get(key) === running) inFlight.delete(key);
  });
  inFlight.set(key, running);
  return running;
}

module.exports = { BACKUP_INTERVAL_MS, FRESHNESS_MS, RETRY_AFTER_MS, receiptFile,
  readReceipt, backupDue, publicStatus, createAndRecordVerification };
