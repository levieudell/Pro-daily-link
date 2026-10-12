'use strict';
function readJsonBody(req, { maxBytes = 16_000_000 } = {}) {
  if (req.parsedBodyPromise) return req.parsedBodyPromise;
  req.parsedBodyPromise = new Promise((resolve, reject) => {
    let chunks = [], length = 0, settled = false;
    req.on('data', value => {
      if (settled) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += bytes.length;
      if (length > maxBytes) {
        settled = true; chunks = [];
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.resume(); return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      // Decode once: a UTF-8 character may span any number of stream chunks.
      const raw = Buffer.concat(chunks, length).toString('utf8'); chunks = [];
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { error.statusCode = 400; reject(error); }
    });
    req.on('error', error => { if (!settled) { settled = true; chunks = []; reject(error); } });
  });
  return req.parsedBodyPromise;
}
module.exports = { readJsonBody };
