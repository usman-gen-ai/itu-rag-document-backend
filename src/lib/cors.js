'use strict';

// FRONTEND_ORIGIN: comma-separated list of allowed origins (no spaces), or "*".
const ALLOWED = (process.env.FRONTEND_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (ALLOWED.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && ALLOWED.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h.Vary = 'Origin';
  }
  return h;
}

/** Express middleware. Answers the OPTIONS preflight with 204 before any route runs. */
function cors(req, res, next) {
  res.set(corsHeaders(req.headers.origin));
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

module.exports = cors;
module.exports.corsHeaders = corsHeaders;
