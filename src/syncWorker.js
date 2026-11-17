'use strict';
const { randomUUID } = require('crypto');
const {
  StartIngestionJobCommand,
  ListIngestionJobsCommand,
} = require('@aws-sdk/client-bedrock-agent');
const { ChangeMessageVisibilityCommand } = require('@aws-sdk/client-sqs');
const { agent, sqs } = require('./lib/clients');

const { KNOWLEDGE_BASE_ID: KB_ID, DATA_SOURCE_ID: DS_ID, SQS_QUEUE_URL: QUEUE_URL } = process.env;

/** True if at least one record is a real document upload (not metadata / test event). */
function hasDocumentUpload(record) {
  let body;
  try { body = JSON.parse(record.body); } catch { return false; }
  return (body.Records || []).some((r) => {
    if (!String(r.eventName || '').startsWith('ObjectCreated')) return false;
    const key = decodeURIComponent((r.s3?.object?.key || '').replace(/\+/g, ' '));
    return key.startsWith('uploads/') && !key.endsWith('.metadata.json');
  });
}

async function ingestionAlreadyRunning() {
  try {
    const out = await agent.send(new ListIngestionJobsCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID,
      maxResults: 5,
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
    }));
    return (out.ingestionJobSummaries || []).some((j) => ['STARTING', 'IN_PROGRESS'].includes(j.status));
  } catch (err) {
    console.warn('ListIngestionJobs failed, falling back to StartIngestionJob:', err.name);
    return false;
  }
}

/** Push messages back with exponential backoff (30s, 60s, 120s ... capped at 10 min). */
async function backoff(records) {
  await Promise.all(records.map((r) => {
    const n = Number(r.attributes?.ApproximateReceiveCount || 1);
    const timeout = Math.min(600, 30 * 2 ** (n - 1));
    return sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: r.receiptHandle,
      VisibilityTimeout: timeout,
    })).catch((e) => console.warn('ChangeMessageVisibility failed:', e.name));
  }));
}

exports.handler = async (event) => {
  const relevant = event.Records.filter(hasDocumentUpload);
  console.log(`Received ${event.Records.length} message(s), ${relevant.length} document upload(s).`);

  // Metadata files / S3 test events are acknowledged and ignored.
  if (relevant.length === 0) return { batchItemFailures: [] };

  const failAll = () => ({ batchItemFailures: relevant.map((r) => ({ itemIdentifier: r.messageId })) });

  // One ingestion job covers every file currently in the bucket, so a single call serves the whole batch.
  if (await ingestionAlreadyRunning()) {
    console.log('Ingestion job already running; retrying this batch later.');
    await backoff(relevant);
    return failAll();
  }

  try {
    const out = await agent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID,
      clientToken: randomUUID(),
      description: `Auto-sync for ${relevant.length} upload(s)`,
    }));
    console.log('Started ingestion job', out.ingestionJob?.ingestionJobId);
    return { batchItemFailures: [] };
  } catch (err) {
    // Files uploaded while a job runs may be missed by that job, so retry after it finishes.
    const retryable = ['ConflictException', 'ThrottlingException', 'ServiceQuotaExceededException',
      'InternalServerException'].includes(err.name);
    console.error(`StartIngestionJob failed (${err.name}): ${err.message}`, { retryable });
    if (retryable) await backoff(relevant);
    return failAll(); // after maxReceiveCount the message lands in the DLQ
  }
};
