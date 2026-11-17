'use strict';
const path = require('path');

const ALLOWED_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateUserId(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
    throw new HttpError(400, 'userId must be 1-64 characters: letters, digits, "_" or "-".');
  }
  return userId;
}

function validateQuestion(q) {
  if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'question is required.');
  if (q.length > 2000) throw new HttpError(400, 'question must be at most 2000 characters.');
  return q.trim();
}

/** Strips paths, normalises characters, lower-cases the extension and maps it to a content type. */
function sanitizeFile(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new HttpError(400, 'fileName is required.');
  }
  const base = path.basename(fileName.replace(/\\/g, '/')).normalize('NFKD');
  const ext = path.extname(base).toLowerCase();
  const contentType = ALLOWED_TYPES[ext];
  if (!contentType) {
    throw new HttpError(400, `Unsupported file type. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`);
  }
  let stem = base
    .slice(0, base.length - path.extname(base).length)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);
  if (!stem) stem = 'document';
  return { fileName: `${stem}${ext}`, contentType };
}

const isMetadataKey = (key) => key.endsWith('.metadata.json');

module.exports = { HttpError, validateUserId, validateQuestion, sanitizeFile, isMetadataKey };
