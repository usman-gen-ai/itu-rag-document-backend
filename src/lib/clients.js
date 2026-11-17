'use strict';
const { S3Client } = require('@aws-sdk/client-s3');
const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
const { SQSClient } = require('@aws-sdk/client-sqs');

const region = process.env.AWS_REGION;

module.exports = {
  // WHEN_REQUIRED stops newer SDKs from adding x-amz-checksum-* params to presigned URLs,
  // which makes browser PUT uploads fail with signature/checksum errors.
  s3: new S3Client({
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }),
  agentRuntime: new BedrockAgentRuntimeClient({ region, maxAttempts: 6, retryMode: 'adaptive' }),
  agent: new BedrockAgentClient({ region, maxAttempts: 5, retryMode: 'adaptive' }),
  sqs: new SQSClient({ region }),
};
