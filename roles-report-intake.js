'use strict';
// One bounded normal-report intent. Provider checkpoints may retain a Draft;
// recovery is read-only and never supplies a general permission or a retry.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const daily = require('./daily-admission'), access = require('./daily-access'), registry = require('./capability-registry');
const dto = require('./compat-workspace-projections');
const collection = 'rolesReportIntakes', purpose = 'normal-report-intake-v1';
const extractedFields = Object.freeze({ summary: 2000, labor: 2000, quantity: 2000, issue: 2000, next: 2000, originalLanguage: 40, englishTranslation: 20000, source: 80, warning: 2000 });
const textFields = ['crew', 'foreman', 'notes', 'weather', 'temperature', 'materials', 'equipment', 'delays', 'safety', 'signature', 'summary', 'labor', 'quantity', 'issue', 'next', 'noteLanguage', 'englishTranslation'];
const createFields = ['projectId', 'sourceAssignmentId', 'dateIso', 'status', ...textFields, 'productionEntries', 'laborEntries', 'workSuggestions', 'templateId', 'templateVersion', 'customFields', ...require('./resource-report-variants').safetyFields];
const editFields = createFields.filter(name => !['projectId', 'noteLanguage', 'englishTranslation', 'templateId', 'templateVersion'].includes(name)).concat('laborExclusions');
const fail = (statusCode, message, code = 'PDL_REPORT_INTAKE') => { throw Object.assign(Error(message), { statusCode, code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([name]) => !fields.includes(name)));
const clean = db => omit(db, [collection, 'rolesProviderAttempts']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function projectExtracted(raw) {
  if (!object(raw)) fail(400, 'Use finite extracted report text.');
  const result = {};
  for (const [name, limit] of Object.entries(extractedFields)) if (Object.hasOwn(raw, name)) { if (typeof raw[name] !== 'string' || raw[name].length > limit) fail(400, 'Use bounded extracted report text.'); result[name] = raw[name]; }
  return result;
}
function validateExtracted(raw) {
  if (!object(raw) || Object.keys(raw).some(name => !Object.hasOwn(extractedFields, name))) fail(400, 'Extracted text cannot supply daily bindings or security fields.');
  return projectExtracted(raw);
}
function one(db, name, value) {
  const rows = db[name] || [];
  if (!Array.isArray(rows) || rows.some(row => !object(row) || !id(row.id) || row.companyId !== undefined && row.companyId !== db.company.id) || new Set(rows.map(row => row.id)).size !== rows.length) fail(409, 'Report intake source identities need reconciliation.');
  const row = rows.find(row => row.id === value); if (!row) fail(404, 'Report or project not found.'); return row;
}
function normalizeReport(raw, db, { action = 'createReport', id: reportId } = {}) {
  const fields = action === 'createReport' ? createFields : editFields;
  const aliases = ['project', 'projectId', 'extracted', 'productions', 'laborEvidence', 'customFieldSuggestions', 'originalLanguage', 'source', 'warning', 'englishTranslation', 'noteLanguage'];
  if (!object(raw) || Object.keys(raw).some(name => !fields.includes(name) && !aliases.includes(name))) fail(400, 'Use only the reviewed report fields.');
  const extracted = Object.hasOwn(raw, 'extracted') ? validateExtracted(raw.extracted) : projectExtracted(raw);
  const report = Object.fromEntries(fields.filter(name => Object.hasOwn(raw, name)).map(name => [name, structuredClone(raw[name])]));
  const projectId = action === 'createReport' ? raw.projectId ?? db.projects?.[raw.project]?.id : db.projects?.[one(db, 'reports', reportId).project]?.id;
  if (!id(projectId) || Object.hasOwn(raw, 'project') && (!Number.isSafeInteger(raw.project) || db.projects?.[raw.project]?.id !== projectId) || Object.hasOwn(raw, 'projectId') && raw.projectId !== projectId) fail(400, 'Use the current selected report project.');
  one(db, 'projects', projectId);
  if (action === 'createReport') { report.projectId = projectId; if (!Object.hasOwn(report, 'noteLanguage') && extracted.originalLanguage) report.noteLanguage = extracted.originalLanguage; if (!Object.hasOwn(report, 'englishTranslation') && extracted.englishTranslation) report.englishTranslation = extracted.englishTranslation; }
  return daily.parse({ action, ...(action === 'editReport' ? { id: reportId } : {}), details: report });
}
function parseCompound(raw, db, method, path) {
  const action = method === 'POST' && path === '/api/reports' ? 'createReport' : method === 'PATCH' && /^\/api\/reports\/[1-9]\d*$/.test(path) ? 'editReport' : null;
  if (!action || !object(raw) || Object.keys(raw).some(name => !['report', 'files', 'caption', 'tags'].includes(name)) || !Array.isArray(raw.files) || raw.files.length > 8 || raw.files.length === 0 && !require('./resource-report-variants').safetyFields.some(name => Object.hasOwn(raw.report || {}, name)) || typeof raw.caption !== 'string' || raw.caption.length > 500 || !Array.isArray(raw.tags) || raw.tags.length > 12 || raw.tags.some(value => typeof value !== 'string' || value.length > 80)) fail(400, 'Review one report with bounded photos or explicit safety fields.');
  const operation = normalizeReport(raw.report, db, { action, ...(action === 'editReport' ? { id: Number(path.split('/')[3]) } : {}) });
  if (!['Draft', 'Needs review', ...(action === 'editReport' ? ['Missing data', 'Approved'] : [])].includes(operation.details.status)) fail(400, 'Choose the intended final daily status.');
  let total = 0;
  const files = raw.files.map(file => {
    if (!object(file) || Object.keys(file).some(name => !['name', 'type', 'data', 'lastModified'].includes(name)) || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || typeof file.data !== 'string' || file.data.length > 8000100 || Object.hasOwn(file, 'lastModified') && (!Number.isSafeInteger(file.lastModified) || file.lastModified < 0 || file.lastModified > 8640000000000000)) fail(400, 'Choose bounded JPG, PNG or WebP files.');
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.data), bytes = match && Buffer.from(match[2], 'base64');
    if (!match || match[1] !== file.type || !bytes || bytes.length < 12 || bytes.length > 6000000 || bytes.toString('base64') !== match[2] || (total += bytes.length) > 15000000 || file.type === 'image/jpeg' && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || file.type === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || file.type === 'image/webp' && !(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')) fail(400, 'Photo bytes do not match the bounded declared image type.');
    return { ...file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  return { operation, caption: raw.caption.trim(), tags: [...new Set(raw.tags.map(value => value.trim().toLowerCase()).filter(Boolean))], files };
}
function createHandler(h) {
  if (!h || !Buffer.isBuffer(h.key) || h.key.length !== 32) fail(503, 'Report intake signing-key custody is required.');
  const sign = row => crypto.createHmac('sha256', h.key).update(purpose + ':' + canonicalHash(omit(row, ['signature']))).digest('hex');
  function valid(db) {
    const rows = db[collection] || [], ids = new Set();
    if (!Array.isArray(rows) || rows.length > 10000 || Buffer.byteLength(JSON.stringify(rows)) > 120000000) fail(409, 'Report intake custody needs reconciliation.');
    for (const row of rows) {
      const fields = ['purpose', 'operationId', 'companyId', 'actorId', 'actorRole', 'sessionHash', 'projectId', 'reportId', 'action', 'originalReportIdsHash', 'originalReportHash', 'originalReport', 'planHash', 'fileFacts', 'caption', 'tags', 'expectedStatus', 'state', 'uploads', 'photos', 'reportHash', 'createdAt', 'finishedAt', 'signature'];
      if (!object(row) || !equal(Object.keys(row).sort(), fields.sort()) || row.purpose !== purpose || !uuid(row.operationId) || ids.has(row.operationId) || row.companyId !== db.company.id || !id(row.actorId) || !['owner', 'admin', 'project_manager', 'foreman', 'field'].includes(row.actorRole) || !hash(row.sessionHash) || !id(row.projectId) || !id(row.reportId) || !['createReport', 'editReport'].includes(row.action) || !hash(row.originalReportIdsHash) || row.originalReportHash !== null && !hash(row.originalReportHash) || !hash(row.planHash) || !['pending', 'complete'].includes(row.state) || !Array.isArray(row.fileFacts) || row.fileFacts.length > 8 || !Array.isArray(row.uploads) || row.uploads.length > row.fileFacts.length || !Array.isArray(row.photos) || row.photos.length > row.fileFacts.length || row.reportHash !== null && !hash(row.reportHash) || !iso(row.createdAt) || row.finishedAt !== null && !iso(row.finishedAt) || row.signature !== sign(row)) fail(409, 'Original report intake proof needs reconciliation.');
      if (row.action === 'createReport' && (row.originalReport !== null || row.originalReportHash !== null) || row.action === 'editReport' && (!object(row.originalReport) || canonicalHash(row.originalReport) !== row.originalReportHash)) fail(409, 'Original report source proof needs reconciliation.');
      ids.add(row.operationId);
    }
    return rows;
  }
  function actor(db, req, row) {
    const auth = h.currentActor ? h.currentActor(req, db) : req.auth;
    if (!auth?.user || !auth.session || auth.companyId != null && auth.companyId !== db.company.id) fail(401, 'Current report account required.');
    const stored = one(db, 'users', auth.user.id), user = registry.actor(db, registry.normalize(stored));
    if (stored.status !== 'Active' || user.role !== auth.user.role || row && (row.actorId !== user.id || row.actorRole !== user.role || row.companyId !== db.company.id || row.sessionHash !== auth.session.tokenHash)) fail(403, 'Original report account and session required.');
    const session = (db.sessions || []).find(value => value.tokenHash === auth.session.tokenHash && value.userId === user.id && value.companyId === db.company.id);
    if (!session || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) fail(401, 'Original report session expired.');
    return { ...auth, user };
  }
  function authorize(db, req, intake) {
    const auth = actor(db, req, intake.record), operation = intake.parsed.operation;
    if (operation.action === 'createReport') daily.authorize(db, auth.user, operation);
    else {
      daily.authorize(db, auth.user, operation);
      if (intake.record.originalReport.status === 'Approved' && !access.access(db, auth.user).approveReports) fail(403, 'Current approval permission required for the original approved daily.');
    }
    return auth;
  }
  function stage(context) { if (typeof h.stage !== 'function') fail(503, 'Reviewed report intake staging required.'); h.stage(context.db); }
  function seal(context, intake) {
    const row = intake.record; row.signature = sign(row);
    context.db[collection] = valid(context.db).map(value => value.operationId === row.operationId ? row : value);
    // The in-flight proof has already validated each exact actual handler result.
    intake.allowedHash = canonicalHash(clean(context.db)); stage(context);
  }
  function validateDelta(before, after, req, intake) {
    if (!intake || !uuid(intake.record?.operationId) || intake.companyId !== after.company.id) fail(409, 'Current report intake proof required.');
    valid(before); const records = valid(after), row = records.find(value => value.operationId === intake.record.operationId);
    if (!row || !equal(row, intake.record) || !equal(records, [...valid(before).filter(value => value.operationId !== row.operationId), row])) fail(409, 'Report intake crossed unrelated custody records.');
    authorize(after, req, intake);
    if (canonicalHash(clean(after)) !== intake.allowedHash) fail(409, 'Report intake changed unrelated business records.');
  }
  function admitProvider(context, req, kind, facts) {
    const intake=context.rolesReportIntake,index=intake?.currentFileIndex,file=intake?.parsed.files[index];
    if(!file||!['storage-upload','local-upload'].includes(kind))fail(503,'Only this intake\'s selected image upload may dispatch.');
    authorize(context.db,req,intake);
    const keys=kind==='storage-upload'?['bucket','key','hash','type']:['file','hash'];
    if(!object(facts)||Object.keys(facts).some(name=>!keys.includes(name))||facts.hash!==file.sha256||kind==='storage-upload'&&(facts.bucket!=='project-photos'||facts.type!==file.type||typeof facts.key!=='string'||!facts.key.startsWith(context.db.company.id+'/')||facts.key.length>2048)||kind==='local-upload'&&(typeof facts.file!=='string'||!/^uploads\/[a-zA-Z0-9._-]+$/.test(facts.file)||facts.file.includes('..'))||intake.record.uploads.length!==index)fail(409,'Original image upload target needs reconciliation.');
    intake.record.uploads.push({index,kind,sha256:file.sha256,type:file.type,state:'admitted',...(kind==='storage-upload'?{bucket:facts.bucket,key:facts.key}:{file:facts.file})});
    seal(context,intake);
  }
  function status(db, req, operationId) {
    const row = valid(db).find(value => value.operationId === operationId); if (!row) fail(404, 'Original report intake not found.');
    const auth = actor(db, req, row);
    if (!access.access(db, auth.user).viewReports || !access.projectAllowed(db, auth.user, row.projectId)) fail(403, 'Current daily view and original project permission required.');
    const current = (db.reports || []).find(value => value.id === row.reportId), same = current && row.reportHash === canonicalHash(current);
    if (same && !access.reportInScope(db, auth.user, current, 'viewReports')) fail(404, 'Original daily not found.');
    const attempts = (db.rolesProviderAttempts || []).filter(value => value.operationId === row.operationId), unknown = attempts.some(value => value.status === 'unknown');
    const result = { operationId: row.operationId, state: !same ? 'changed' : unknown ? 'unknown' : row.state, reportId: row.reportId, finalStatus: row.expectedStatus, acceptedPhotoCount: row.photos.length, complete: row.state === 'complete' && same, retryAllowed: false };
    if (result.complete) {
      result.report = daily.reportProjection(db, auth.user, current, h.presentReport);
      result.files = row.photos.flatMap(original => {
        const photo = (db.photos || []).find(value => value.id === original.id);
        return photo && photo.reportId === row.reportId && db.projects?.[photo.project]?.id === row.projectId && photo.url === original.url && photo.storageBucket === original.bucket && photo.storageKey === original.key ? [dto.photo(photo)] : [];
      });
    }
    return result;
  }
  async function invoke(context, method, path, body) {
    const result = await h.invoke(method, path, body), response = result || context.response;
    if (!response || response.status >= 400) fail(response?.status || 503, response?.data?.error || 'The compound report needs review.');
    return response.data;
  }
  async function checkpoint(context, intake) { seal(context, intake); if (typeof h.commit !== 'function') fail(503, 'Reviewed report intake checkpoint required.'); await h.commit(); }
  function checkReport(intake, db, auth) {
    const sample = clean(structuredClone(db)); if(Object.hasOwn(intake.initial,'photos'))sample.photos=structuredClone(intake.initial.photos);else delete sample.photos;
    daily.validateDelta(clean(intake.initial), sample, auth.user, intake.parsed.operation);
    if(typeof h.validateBusinessDependencies==='function')h.validateBusinessDependencies(clean(intake.initial),sample,{...intake.req,auth,rolesBody:structuredClone(intake.parsed.operation.details)});
    const report = one(db, 'reports', intake.record.reportId);
    if (report.project !== intake.projectIndex || !['Draft', intake.record.expectedStatus].includes(report.status) || intake.record.action === 'createReport' && ['rateSnapshot', 'rateHistory', 'rateReview'].some(name => Object.hasOwn(report, name))) fail(409, 'New report identity or financial records changed.');
    return report;
  }
  function checkPhoto(before, db, value, intake, index, auth) {
    const old = before.photos || [], current = db.photos || [], file = intake.parsed.files[index], at = value.createdAt;
    const expected = { id: Math.max(0, ...old.map(row => row.id)) + 1, project: intake.projectIndex, reportId: intake.record.reportId, changeId: null, workdayId: null, phase: null, source: 'field', caption: intake.parsed.caption, tags: intake.parsed.tags, capturedAt: file.lastModified ? new Date(file.lastModified).toISOString() : at, uploader: auth.user.name, createdAt: at, url: value.url, storageBucket: value.storageBucket, storageKey: value.storageKey };
    const admitted=intake.record.uploads[index],stored=admitted?.kind==='storage-upload'?value.storageBucket===admitted.bucket&&value.storageKey===admitted.key&&value.url==='/api/files/project-photos/'+admitted.key:admitted?.kind==='local-upload'?value.storageBucket==null&&value.storageKey==null&&value.url==='/'+admitted.file:false;
    if (!id(expected.id) || !iso(at) || !equal(value, expected) || !equal(current, [...old, expected]) || !equal(omit(clean(before), ['photos']), omit(clean(db), ['photos'])) || old.some(row => row.url === value.url) || typeof value.url !== 'string' || !stored) fail(409, 'Intake attaches only its exact newly uploaded image references.');
    return expected;
  }
  async function handle(req, res, url) {
    const context = h.context(), lookup = /^\/api\/company\/report-intakes\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && lookup) { h.json(res, 200, status(context.db, req, lookup[1])); return true; }
    if (!['POST', 'PATCH'].includes(req.method) || !(url.pathname === '/api/reports' || /^\/api\/reports\/[1-9]\d*$/.test(url.pathname))) return false;
    const body = await h.body(req); if (!body?.report || !Object.hasOwn(body, 'files')) return false;
    const parsed = parseCompound(body, context.db, req.method, url.pathname), auth = actor(context.db, req), operationId = context.rolesOperationId;
    if (!uuid(operationId)) fail(400, 'Use one original report operation identity.');
    const facts = parsed.files.map(file => omit(file, ['data'])), planHash = canonicalHash({ operation: parsed.operation, files: facts, caption: parsed.caption, tags: parsed.tags });
    const prior = valid(context.db).find(value => value.operationId === operationId);
    if (prior) { actor(context.db, req, prior); if (prior.planHash !== planHash) fail(409, 'Original intake input changed.'); const original = status(context.db, req, operationId); h.json(res, original.complete ? 200 : 409, { original: true, operationId, intake: original, ...(original.complete ? {} : { error: 'The original report intake needs review. It will not upload or create again.', code: 'PDL_REPORT_INTAKE_PENDING' }) }); return true; }
    const unknown=(context.db.rolesProviderAttempts||[]).filter(value=>['storage-upload','local-upload'].includes(value.kind)&&value.status==='unknown').map(value=>value.operationId);
    if(valid(context.db).some(row=>unknown.includes(row.operationId)&&row.uploads.some(upload=>parsed.files.some(file=>file.sha256===upload.sha256&&file.type===upload.type))))fail(409,'An original upload of these bytes needs review before a new report can be created.','PDL_REPORT_INTAKE_PENDING');
    daily.authorize(context.db, auth.user, parsed.operation);
    const original = parsed.operation.action === 'editReport' ? one(context.db, 'reports', Number(parsed.operation.id)) : null, reportId = original?.id || Math.max(0, ...(context.db.reports || []).map(row => row.id)) + 1, projectId = original ? context.db.projects[original.project].id : parsed.operation.details.projectId;
    if (!id(reportId)) fail(409, 'Report identity capacity needs review.');
    const record = { purpose, operationId, companyId: context.db.company.id, actorId: auth.user.id, actorRole: auth.user.role, sessionHash: auth.session.tokenHash, projectId, reportId, action: parsed.operation.action, originalReportIdsHash: canonicalHash((context.db.reports || []).map(row => row.id)), originalReportHash: original ? canonicalHash(original) : null, originalReport: original ? structuredClone(original) : null, planHash, fileFacts: facts, caption: parsed.caption, tags: parsed.tags, expectedStatus: parsed.operation.details.status, state: 'pending', uploads: [], photos: [], reportHash: original ? canonicalHash(original) : null, createdAt: new Date().toISOString(), finishedAt: null, signature: '' };
    const intake = { companyId: context.db.company.id, req, initial: structuredClone(context.db), projectIndex: context.db.projects.findIndex(row => row.id === projectId), record, parsed, allowedHash: canonicalHash(clean(context.db)) };
    record.signature = sign(record); context.db[collection] = [...valid(context.db), record]; context.rolesReportIntake = intake; stage(context);
    if (parsed.operation.action === 'createReport') {
      await invoke(context, 'POST', '/api/reports', { ...parsed.operation.details, status: 'Draft' });
      const report = checkReport(intake, context.db, auth); record.reportHash = canonicalHash(report);
      if (parsed.files.length) await checkpoint(context, intake);
    } else if (parsed.files.length) await checkpoint(context, intake);
    for (let index = 0; index < parsed.files.length; index++) {
      const currentAuth = authorize(context.db, req, intake), before = structuredClone(context.db), file = omit(parsed.files[index], ['sha256']);
      intake.currentFileIndex=index;
      const rows = await invoke(context, 'POST', '/api/photos', { project: intake.projectIndex, projectId, reportId, workdayId: null, phase: null, changeId: null, source: 'field', caption: parsed.caption, tags: parsed.tags, files: [file] });
      if (!Array.isArray(rows) || rows.length !== 1) fail(409, 'One original image must produce one reference.');
      const photo = checkPhoto(before, context.db, rows[0], intake, index, currentAuth);
      record.uploads[index].state='attached';record.photos.push({ id: photo.id, sha256: parsed.files[index].sha256, url: photo.url, bucket: photo.storageBucket, key: photo.storageKey }); await checkpoint(context, intake);
    }
    authorize(context.db, req, intake);
    await invoke(context, 'PATCH', '/api/reports/' + reportId, parsed.operation.details);
    const safety = require('./resource-report-variants');
    if(safety.safetyFields.some(name=>Object.hasOwn(parsed.operation.details,name))){
      const before=structuredClone(context.db),op=safety.parse({kind:'reportSafety',method:'PATCH',path:'/api/reports/'+reportId+'/safety',details:Object.fromEntries(safety.safetyFields.filter(name=>Object.hasOwn(parsed.operation.details,name)).map(name=>[name,parsed.operation.details[name]]))});
      await invoke(context,'PATCH',op.path,op.details);
      safety.validateSafetyConsequence(before,context.db,op,actor(context.db,req,record),{presentReport:h.presentReport});
    }
    const report = checkReport(intake, context.db, actor(context.db, req, record));
    if (report.status !== record.expectedStatus) fail(409, 'The intended report status was not saved.');
    record.reportHash = canonicalHash(report); record.state = 'complete'; record.finishedAt = new Date().toISOString(); seal(context, intake);
    const current = actor(context.db, req, record), visible = daily.reportProjection(context.db, current.user, report, h.presentReport);
    h.json(res, parsed.operation.action === 'createReport' ? 201 : 200, { operationId, report: visible, files: record.photos.map(value => dto.photo(one(context.db, 'photos', value.id))), intake: { state: 'complete', complete: true, retryAllowed: false } }); return true;
  }
  return { handle, validateDelta, valid, status, admitProvider };
}
module.exports = { collection, extractedFields, projectExtracted, validateExtracted, normalizeReport, parseCompound, createHandler };
