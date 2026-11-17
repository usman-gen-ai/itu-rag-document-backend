'use strict';
const { randomUUID } = require('crypto');
const express = require('express');
const {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const {
  GetKnowledgeBaseDocumentsCommand,
  ListIngestionJobsCommand,
  StartIngestionJobCommand,
} = require('@aws-sdk/client-bedrock-agent');

const { s3, agentRuntime, agent } = require('./lib/clients');
const {
  HttpError, validateUserId, validateQuestion, sanitizeFile, isMetadataKey,
} = require('./lib/validate');
const { STRICT_RAG_PROMPT, LOOSE_RAG_PROMPT } = require('./lib/prompt');
const cors = require('./lib/cors');

const app = express();
app.use(cors); // must be first: answers OPTIONS preflight
app.use(express.json({ limit: '100kb' }));

const {
  SOURCE_BUCKET_NAME: BUCKET,
  KNOWLEDGE_BASE_ID: KB_ID,
  DATA_SOURCE_ID: DS_ID,
  CHAT_MODEL_ID,
  AWS_REGION: REGION,
} = process.env;
const NUM_RESULTS = Math.min(Math.max(parseInt(process.env.NUMBER_OF_RESULTS || '6', 10), 1), 25);
const PAGE_KEY = 'x-amz-bedrock-kb-document-page-number';

const modelArn = CHAT_MODEL_ID.startsWith('arn:')
  ? CHAT_MODEL_ID
  : `arn:aws:bedrock:${REGION}::foundation-model/${CHAT_MODEL_ID}`;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Live-demo switch: STRICT_RAG=false turns OFF the zero-hallucination checks (loose prompt, no "not found" guards).
// Change it in the Lambda console (Configuration -> Environment variables); no redeploy needed. Default: true.
const STRICT_RAG = String(process.env.STRICT_RAG ?? 'true').trim().toLowerCase() !== 'false';

const NOT_FOUND_ANSWER = "I couldn't find this in your uploaded documents.";
const TAG_RE = /^\s*\[(GROUNDED|CHAT|NOTFOUND)\]\s*/i;
const ANY_TAG_RE = /\[(GROUNDED|CHAT|NOTFOUND)\]\s*/gi;

/** Optional per-document scope: sanitised file names, max 20, invalid entries are skipped (never throws). */
function parseDocuments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const d of input) {
    if (typeof d !== 'string') continue;
    try {
      const { fileName } = sanitizeFile(d);
      if (!out.includes(fileName)) out.push(fileName);
    } catch { /* skip unsupported / empty names */ }
    if (out.length >= 20) break;
  }
  return out;
}

/** Always scoped to the user; optionally narrowed to selected documents. */
function buildFilter(uid, docs) {
  const userFilter = { equals: { key: 'userId', value: uid } };
  if (!docs.length) return userFilter;
  const docFilter = docs.length === 1
    ? { equals: { key: 'fileName', value: docs[0] } }
    : { in: { key: 'fileName', value: docs } };
  return { andAll: [userFilter, docFilter] };
}

// ---------------------------------------------------------------- health
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  region: REGION,
  knowledgeBaseId: KB_ID,
  dataSourceId: DS_ID,
  bucket: BUCKET,
  chatModelArn: modelArn,
  numberOfResults: NUM_RESULTS,
  strictRag: STRICT_RAG,
}));

// ---------------------------------------------------------------- POST /api/upload-url
app.post('/api/upload-url', asyncRoute(async (req, res) => {
  const { fileName, userId } = req.body || {};
  const uid = validateUserId(userId);
  const file = sanitizeFile(fileName);
  const key = `uploads/${uid}/${file.fileName}`;

  // 1) Companion metadata FIRST, so it already exists when the document lands and triggers ingestion.
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${key}.metadata.json`,
    Body: JSON.stringify({ metadataAttributes: { userId: uid, fileName: file.fileName } }),
    ContentType: 'application/json',
  }));

  // 2) Presigned PUT for the document itself.
  const expiresIn = 900;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: file.contentType }),
    { expiresIn },
  );

  res.status(201).json({
    uploadUrl,
    method: 'PUT',
    requiredHeaders: { 'Content-Type': file.contentType }, // must match, or S3 rejects the signature
    key,
    fileName: file.fileName,
    expiresIn,
  });
}));

// ---------------------------------------------------------------- POST /api/chat
// The model starts its reply with a tag ([GROUNDED] | [CHAT] | [NOTFOUND], see lib/prompt.js).
// The tag decides whether sources are shown, so greetings never get citations and no keyword lists are needed.
app.post('/api/chat', asyncRoute(async (req, res) => {
  const { userId, question, sessionId } = req.body || {};
  const uid = validateUserId(userId);
  const text = validateQuestion(question);
  const docs = parseDocuments(req.body?.documents);

  const command = new RetrieveAndGenerateCommand({
    input: { text },
    ...(sessionId ? { sessionId } : {}),
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: NUM_RESULTS,
            filter: buildFilter(uid, docs), // multi-user isolation (+ optional document scope)
          },
        },
        generationConfiguration: {
          promptTemplate: { textPromptTemplate: STRICT_RAG ? STRICT_RAG_PROMPT : LOOSE_RAG_PROMPT },
          inferenceConfig: { textInferenceConfig: { temperature: 0, maxTokens: 1024 } },
        },
      },
    },
  });

  const resp = await agentRuntime.send(command);

  // Read and strip the tag.
  const raw = resp.output?.text || '';
  const tagMatch = raw.match(TAG_RE);
  const tag = tagMatch ? tagMatch[1].toUpperCase() : null;
  const answerText = raw.replace(TAG_RE, '').replace(ANY_TAG_RE, '').trim();

  // Collect unique, user-owned sources (defence in depth on top of the metadata filter).
  const seen = new Set();
  const sources = [];
  for (const citation of resp.citations || []) {
    for (const ref of citation.retrievedReferences || []) {
      const uri = ref.location?.s3Location?.uri;
      if (!uri || !uri.includes(`/uploads/${uid}/`)) continue;
      const documentName = decodeURIComponent(uri.split('/').pop());
      if (docs.length && !docs.includes(documentName)) continue;
      const rawPage = ref.metadata?.[PAGE_KEY];
      const page = rawPage !== undefined && !Number.isNaN(Number(rawPage)) ? Number(rawPage) : null;
      const id = `${documentName}#${page}`;
      if (seen.has(id)) continue;
      seen.add(id);
      sources.push({
        documentName,
        page, // null for formats without pages (e.g. TXT)
        snippet: (ref.content?.text || '').slice(0, 300),
        s3Uri: uri,
      });
    }
  }

  // Demo mode (STRICT_RAG=false): return whatever the model said, no tag logic and no "not found" guards.
  if (!STRICT_RAG) {
    return res.json({ answer: answerText, sources, type: 'grounded', sessionId: resp.sessionId });
  }

  const notFound = () => res.json({ answer: NOT_FOUND_ANSWER, sources: [], type: 'notfound', sessionId: resp.sessionId });

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'chat',
    tag,
    strict: STRICT_RAG,
    sourceCount: sources.length,
    docsFilterCount: docs.length,
    questionLength: text.length,
  }));

  if (tag === 'CHAT') {
    // Greeting / small talk: answer without any sources.
    return res.json({ answer: answerText, sources: [], type: 'chat', sessionId: resp.sessionId });
  }
  if (tag === 'NOTFOUND') return notFound();

  // Zero-hallucination guard: a document answer needs supporting sources.
  if (sources.length === 0) return notFound();
  // Model forgot the tag but still said it could not find the answer.
  if (!tag && /couldn't find this in your uploaded documents/i.test(answerText)) return notFound();

  return res.json({ answer: answerText, sources, type: 'grounded', sessionId: resp.sessionId });
}));

// ---------------------------------------------------------------- GET /api/documents/:userId
const STATUS_MAP = {
  INDEXED: 'READY',
  PARTIALLY_INDEXED: 'READY',
  PENDING: 'PROCESSING',
  STARTING: 'PROCESSING',
  IN_PROGRESS: 'PROCESSING',
  NOT_FOUND: 'QUEUED', // uploaded, ingestion job not yet run
  FAILED: 'FAILED',
  IGNORED: 'FAILED',
};

app.get('/api/documents/:userId', asyncRoute(async (req, res) => {
  const uid = validateUserId(req.params.userId);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  // Metadata companions share the prefix, so over-fetch keys (x2) to fill a page of documents.
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: `uploads/${uid}/`,
    MaxKeys: limit * 2,
    ContinuationToken: cursor,
  }));

  const docs = (list.Contents || [])
    .filter((o) => !isMetadataKey(o.Key))
    .map((o) => ({
      fileName: o.Key.split('/').pop(),
      key: o.Key,
      s3Uri: `s3://${BUCKET}/${o.Key}`,
      size: o.Size,
      uploadedAt: o.LastModified,
      status: 'UNKNOWN',
    }));

  // Ingestion status per document (batches of 10, best-effort).
  const statusByUri = {};
  let statusLookupError = null;
  try {
    for (let i = 0; i < docs.length; i += 10) {
      const batch = docs.slice(i, i + 10);
      const out = await agent.send(new GetKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: KB_ID,
        dataSourceId: DS_ID,
        documentIdentifiers: batch.map((d) => ({ dataSourceType: 'S3', s3: { uri: d.s3Uri } })),
      }));
      for (const d of out.documentDetails || []) {
        statusByUri[d.identifier?.s3?.uri] = { status: d.status, reason: d.statusReason };
      }
    }
  } catch (err) {
    console.warn('Could not fetch ingestion status:', err.name, err.message);
    statusLookupError = `${err.name}: ${err.message}`;
  }

  // Per-document status is not always available for S3 data sources, so also use ingestion jobs:
  // a COMPLETE job that started after the upload means the file has been indexed.
  let jobs = [];
  try {
    const out = await agent.send(new ListIngestionJobsCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID,
      maxResults: 20,
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
    }));
    jobs = out.ingestionJobSummaries || [];
  } catch (err) {
    console.warn('Could not list ingestion jobs:', err.name, err.message);
    statusLookupError = statusLookupError || `${err.name}: ${err.message}`;
  }

  const jobStatusFor = (uploadedAt) => {
    const t = new Date(uploadedAt).getTime();
    const after = jobs.filter((j) => new Date(j.startedAt).getTime() >= t);
    if (after.some((j) => j.status === 'COMPLETE')) return 'READY';
    if (after.some((j) => ['STARTING', 'IN_PROGRESS'].includes(j.status))) return 'PROCESSING';
    if (after.some((j) => ['FAILED', 'STOPPED'].includes(j.status))) return 'FAILED';
    return 'QUEUED'; // no ingestion job has started since the upload yet
  };

  for (const d of docs) {
    const s = statusByUri[d.s3Uri];
    const docStatus = s ? (STATUS_MAP[s.status] || 'PROCESSING') : null;
    if (s) {
      d.rawStatus = s.status;
      if (s.reason) d.statusReason = s.reason;
    }
    if (docStatus === 'READY' || docStatus === 'FAILED') {
      d.status = docStatus;
      d.statusSource = 'document';
    } else if (jobs.length) {
      const js = jobStatusFor(d.uploadedAt);
      d.status = js === 'QUEUED' && docStatus ? docStatus : js;
      d.statusSource = 'ingestion-job';
    } else {
      d.status = docStatus || 'UNKNOWN';
      d.statusSource = s ? 'document' : 'none';
    }
  }

  res.json({
    userId: uid,
    count: docs.length,
    documents: docs,
    latestJob: jobs[0]
      ? { id: jobs[0].ingestionJobId, status: jobs[0].status, startedAt: jobs[0].startedAt, statistics: jobs[0].statistics }
      : null,
    statusLookupError, // non-null => status could not be read from Bedrock (shown as UNKNOWN)
    nextCursor: list.IsTruncated ? list.NextContinuationToken : null,
  });
}));

// ---------------------------------------------------------------- DELETE /api/documents/:userId/:fileName
// Removes the file and its metadata companion, then (best effort) starts an ingestion job so the
// vectors of the deleted file are dropped from the index. S3 notifications only fire on uploads.
app.delete('/api/documents/:userId/:fileName', asyncRoute(async (req, res) => {
  const uid = validateUserId(req.params.userId);
  const { fileName } = sanitizeFile(req.params.fileName);
  const key = `uploads/${uid}/${fileName}`;

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${key}.metadata.json` }));

  try {
    await agent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID,
      clientToken: randomUUID(),
      description: 'Re-sync after document deletion',
    }));
  } catch (err) {
    // ConflictException = a job is already running; never fail the delete because of the sync.
    console.warn('Post-delete ingestion not started:', err.name, err.message);
  }

  res.json({ deleted: true });
}));

// ---------------------------------------------------------------- POST /api/debug/retrieve
// Tests retrieval only (embedding + S3 Vectors + userId filter), WITHOUT the generation model.
// If this works but /api/chat fails, the problem is the chat model (quota / access / ARN).
app.post('/api/debug/retrieve', asyncRoute(async (req, res) => {
  const uid = validateUserId(req.body?.userId);
  const text = validateQuestion(req.body?.question);
  const docs = parseDocuments(req.body?.documents);
  const out = await agentRuntime.send(new RetrieveCommand({
    knowledgeBaseId: KB_ID,
    retrievalQuery: { text },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: NUM_RESULTS,
        filter: buildFilter(uid, docs),
      },
    },
  }));
  res.json({
    count: (out.retrievalResults || []).length,
    results: (out.retrievalResults || []).map((r) => ({
      s3Uri: r.location?.s3Location?.uri,
      score: r.score,
      page: r.metadata?.[PAGE_KEY] ?? null,
      snippet: (r.content?.text || '').slice(0, 200),
    })),
  });
}));

// ---------------------------------------------------------------- GET /api/sync-status
// Latest ingestion jobs: tells the frontend whether syncing is running, finished or failed (and why).
app.get('/api/sync-status', asyncRoute(async (_req, res) => {
  const out = await agent.send(new ListIngestionJobsCommand({
    knowledgeBaseId: KB_ID,
    dataSourceId: DS_ID,
    maxResults: 5,
    sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
  }));
  res.json({
    jobs: (out.ingestionJobSummaries || []).map((j) => ({
      id: j.ingestionJobId,
      status: j.status,
      startedAt: j.startedAt,
      updatedAt: j.updatedAt,
      statistics: j.statistics,
    })),
  });
}));

// ---------------------------------------------------------------- 404 + errors
app.use((_req, res) => res.status(404).json({ error: 'Not found', code: 'NotFound' }));

const HINTS = {
  AccessDeniedException:
    'Permission denied: check the Lambda IAM role, Bedrock model access (Bedrock console -> Model access), or an SCP in your AWS Organization.',
  ValidationException:
    'Bedrock rejected the request: check CHAT_MODEL_ID (model/inference-profile ARN valid for this region), sessionId, or the prompt template.',
  ResourceNotFoundException:
    'Resource not found: check KNOWLEDGE_BASE_ID / DATA_SOURCE_ID, the model ARN, or that sessionId is still valid.',
  ThrottlingException: 'Bedrock is throttling requests. Retry shortly.',
  ServiceQuotaExceededException: 'A Bedrock/AWS quota was exceeded.',
  ModelNotReadyException: 'The model is not ready yet. Retry shortly.',
  ConflictException: 'An ingestion job is already running.',
  NoSuchBucket: 'The source bucket does not exist (check SOURCE_BUCKET_NAME).',
  AccessDenied: 'S3 access denied: check the Lambda IAM role or an SCP.',
};

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const requestId = req.context?.awsRequestId;
  const isAws = Boolean(err.$metadata);

  let status = 500;
  if (err instanceof HttpError) status = err.status;
  else if (err.name === 'ThrottlingException') status = 429;
  else if (isAws) status = 502; // failure of a downstream AWS call
  else if (err.status && err.status < 500) status = err.status; // body-parser etc.

  const code = err.name || 'Error';
  const hint = HINTS[code];

  // Full detail goes to CloudWatch ...
  console.error(JSON.stringify({
    level: 'ERROR',
    path: req.path,
    method: req.method,
    status,
    code,
    message: err.message,
    awsStatus: err.$metadata?.httpStatusCode,
    awsRequestId: err.$metadata?.requestId,
    requestId,
    stack: err.stack,
  }));

  // ... and a readable version goes to the frontend.
  res.status(status).json({
    error: err instanceof HttpError ? err.message : `${code}: ${err.message}`,
    code,
    message: err.message,
    hint,
    retryable: status === 429 || status === 502 || status === 503,
    requestId,
    awsRequestId: err.$metadata?.requestId,
  });
});

module.exports = app;
