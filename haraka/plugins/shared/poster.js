/**
 * poster.js - HTTP POST to the web server
 *
 * POSTs submissions to the web server's internal API,
 * with retries. Also provides ID validation.
 */

const https = require('https');
const http = require('http');
const { getTargetConfig, getWebServerConfig } = require('./config');

/**
 * Send a GET request
 */
function getJSON(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'X-Internal-Token': token },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: { error: data } });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Send a POST request
 */
function postJSON(url, payload, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify(payload);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Internal-Token': token,
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: { error: data } });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * POST with retries
 * @param {string} url
 * @param {object} payload
 * @param {string} token
 * @param {object} retryConfig - { max_attempts, delays_ms }
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status: number, data: object, attempts: number}>}
 */
async function postWithRetry(url, payload, token, retryConfig, timeoutMs) {
  const maxAttempts = retryConfig.max_attempts || 3;
  const delays = retryConfig.delays_ms || [2000, 5000];

  let lastError = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await postJSON(url, payload, token, timeoutMs);
      lastResult = result;

      if (result.ok) {
        return { ...result, attempts: attempt };
      }

      // do not retry 4xx client errors (except 429)
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        return { ...result, attempts: attempt };
      }

      console.log(`[poster] Attempt ${attempt}/${maxAttempts}: HTTP ${result.status}, will retry`);
    } catch (err) {
      lastError = err;
      console.log(`[poster] Attempt ${attempt}/${maxAttempts}: ${err.message}, will retry`);
    }

    // no delay after the last attempt
    if (attempt < maxAttempts) {
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      await sleep(delay);
    }
  }

  if (lastResult) {
    return { ...lastResult, attempts: maxAttempts, ok: false };
  }
  throw lastError || new Error('All retry attempts failed');
}

/**
 * Submit a post to the web server
 * @param {object} submission
 * @returns {Promise<{ok: boolean, data: object}>}
 */
async function submitPost(submission) {
  const target = getTargetConfig();
  const result = await postWithRetry(
    target.webhook_url,
    submission,
    target.webhook_token,
    target.post_retry,
    target.post_timeout_ms,
  );
  return result;
}

/**
 * Validate an ID (calls the internal API)
 * @param {string} id - ID to validate (4 or 6 characters)
 * @returns {Promise<{valid: boolean, type: string, entry_id: string, floor_id: string|null, error: string}>}
 */
async function validateId(id) {
  const ws = getWebServerConfig();
  const url = `http://${ws.internal_host}:${ws.internal_port}/api/internal/validate-id/${encodeURIComponent(id)}`;
  const result = await getJSON(url, ws.internal_token, 5000);
  if (result.ok) return result.data;
  return { valid: false, error: 'Validation request failed' };
}

/**
 * Fetch all authorized emails (synced at Haraka startup)
 * @returns {Promise<string[]>}
 */
async function fetchAuthorizedEmails() {
  const ws = getWebServerConfig();
  const url = `http://${ws.internal_host}:${ws.internal_port}/api/internal/authorized-emails`;
  const result = await getJSON(url, ws.internal_token, 10000);
  if (result.ok && result.data.emails) {
    return result.data.emails;
  }
  return [];
}

/**
 * Tell the web server an email was verified
 * @param {string} email
 * @returns {Promise<{ok: boolean, data: object}>}
 */
async function notifyEmailVerified(email) {
  const ws = getWebServerConfig();
  const url = `http://${ws.internal_host}:${ws.internal_port}/api/internal/email-verified`;
  const payload = { email: email.toLowerCase() };
  return postJSON(url, payload, ws.internal_token, 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getJSON,
  postJSON,
  postWithRetry,
  submitPost,
  validateId,
  fetchAuthorizedEmails,
  notifyEmailVerified,
};
