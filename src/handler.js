'use strict';
const { corsHeaders } = require('./lib/cors');

let inner;

module.exports.handler = async (event, context) => {
  try {
    if (!inner) {
      const serverless = require('serverless-http');
      inner = serverless(require('./app'));
    }
    return await inner(event, context);
  } catch (err) {
    // Anything that escapes Express (init crash, malformed event, ...) still returns JSON + CORS.
    console.error(JSON.stringify({
      level: 'FATAL', code: err.name, message: err.message, stack: err.stack,
      requestId: context?.awsRequestId,
    }));
    const origin = event?.headers?.origin || event?.headers?.Origin;
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      body: JSON.stringify({
        error: `${err.name}: ${err.message}`,
        code: err.name,
        message: err.message,
        hint: 'Unhandled error inside the Lambda. See CloudWatch logs for this requestId.',
        requestId: context?.awsRequestId,
      }),
    };
  }
};
