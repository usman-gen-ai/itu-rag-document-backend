# Poocho AI – Serverless Backend

Express.js (via `serverless-http`) on AWS Lambda behind a public **Lambda Function URL** (no API Gateway, 14m30s timeout) + Amazon Bedrock Knowledge Base backed by **Amazon S3 Vectors**.

```
Frontend ──POST /api/upload-url──► Lambda(api) ──► S3: uploads/{userId}/file.pdf.metadata.json
    │                                        └──► presigned PUT URL
    └──PUT file──► S3 source bucket ──ObjectCreated──► SQS ──► Lambda(syncWorker) ──► StartIngestionJob
                                                                                         │
Frontend ──POST /api/chat──► Lambda(api) ──RetrieveAndGenerate (filter userId)──► KB ◄────┘ (S3 Vectors)
```

## Folder structure
```
poocho-ai-backend/
├── serverless.yml        # all infra: S3, SQS(+DLQ), S3 Vectors, Bedrock KB/DataSource, IAM
├── package.json
├── .env.example
└── src/
    ├── handler.js        # serverless-http wrapper
    ├── app.js            # Express routes
    ├── syncWorker.js     # SQS -> StartIngestionJob
    └── lib/{clients,validate,prompt}.js
```

## Prerequisites
* Node.js 22 (see `.nvmrc`; run `nvm use`), an AWS account, a region where **S3 Vectors** and your chosen Bedrock models exist (e.g. `us-east-1`, `us-west-2`).
* Bedrock model access for **Titan Text Embeddings V2** and your generation model (Bedrock console -> Model access).
* An IAM user with permission to create CloudFormation, Lambda (Function URL), IAM roles, S3, SQS, S3 Vectors and Bedrock resources (`AdministratorAccess` is simplest for first deploy).

## Setup & deploy
```bash
cd poocho-ai-backend
npm install
cp .env.example .env        # fill AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, FRONTEND_ORIGIN
npx sls deploy              # add --stage prod for production
npx sls info                # shows the API base URL
```
Outputs include `KnowledgeBaseId`, `DataSourceId`, `SourceBucketName`, `SyncQueueUrl`. These are already injected into both Lambdas as `KNOWLEDGE_BASE_ID`, `DATA_SOURCE_ID`, `SOURCE_BUCKET_NAME`, `SQS_QUEUE_URL`.

## Try it
```bash
API=https://xxxx.lambda-url.ap-southeast-2.on.aws   # `ApiBaseUrl` output, no trailing slash

# 1. Get upload URL (also writes the .metadata.json companion)
curl -s -X POST $API/api/upload-url -H 'Content-Type: application/json' \
  -d '{"userId":"student_42","fileName":"physics notes.pdf","fileType":"application/pdf"}'

# 2. Upload the file (header must match requiredHeaders)
curl -X PUT "<uploadUrl>" -H 'Content-Type: application/pdf' --data-binary @physics.pdf

# 3. Wait for status READY (SQS batches ~20s, then ingestion runs)
curl -s $API/api/documents/student_42

# 4. Ask a question
curl -s -X POST $API/api/chat -H 'Content-Type: application/json' \
  -d '{"userId":"student_42","question":"What is Newton'"'"'s second law?"}'
```
Chat response:
```json
{ "answer": "...", "sources": [ { "documentName": "physics_notes.pdf", "page": 12, "snippet": "...", "s3Uri": "..." } ], "sessionId": "..." }
```
Pass the returned `sessionId` in the next request for follow-up questions.

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | config check |
| POST | `/api/upload-url` | `{userId, fileName, fileType}` -> presigned PUT; writes `.metadata.json` with `userId` + `fileName` |
| GET | `/api/documents/:userId` | list + ingestion status |
| DELETE | `/api/documents/:userId/:fileName` | deletes file + metadata, then starts a sync to drop its vectors |
| POST | `/api/chat` | `{userId, question, sessionId?, documents?: string[]}`; `documents` limits search to those files (empty = all); response has `type`: `grounded` / `chat` / `notfound` |
| POST | `/api/debug/retrieve` | retrieval only (accepts `documents` too) |
| GET | `/api/sync-status` | latest ingestion jobs |

## How chat decides to show sources
The prompt makes the model start every reply with one tag: `[GROUNDED]` (answer from documents), `[CHAT]` (greeting/small talk) or `[NOTFOUND]`. `src/app.js` strips the tag and shows sources only for grounded answers that have supporting citations. If the model forgets the tag, the backend falls back to the citations (no sources = "not found").

## Design notes
* **Isolation**: every document has a `.metadata.json` with `userId`; every query filters `userId equals <id>`, and returned citations are re-checked against `uploads/{userId}/`.
* **Concurrency**: S3 events -> SQS (20 s batching window, max 2 concurrent workers). One ingestion job covers all pending files. If a job is `IN_PROGRESS` (or `ConflictException` is returned) the messages go back to the queue with exponential backoff (30 s -> 10 min) and finally to the DLQ after 15 attempts.
* **Filtering**: S3 notifications only fire for `.pdf/.docx/.txt`; the worker additionally ignores `*.metadata.json`.
* **Page citations** come from Bedrock's `x-amz-bedrock-kb-document-page-number` (available for PDFs; `page` is `null` for TXT/DOCX if no page info exists).
* **Generation model**: set `CHAT_MODEL_ID` to a model ID, or a full ARN for inference profiles (e.g. `arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic...`).

## Production hardening (recommended)
* `userId` comes from the request body. Add a Cognito/JWT authorizer on the HTTP API and read `userId` from the token claims instead, otherwise one student can query another's ID.
* Add a Bedrock Guardrail, WAF/throttling on API Gateway, and CloudWatch alarms on the DLQ.

## Remove
Buckets must be empty first: empty the source bucket, then `npx sls remove`. If removal of the vector index fails, delete remaining vectors in the S3 Vectors console.
