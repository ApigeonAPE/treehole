/**
 * redis.js - Redis client and keyspace helpers
 *
 * Connects to treehole-redis:6379 and wraps all Redis operations.
 */

const Redis = require('ioredis');

// ============================================================
// constants
// ============================================================

const KEY_PREFIX = {
  AUTHORIZED_EMAILS: 'authorized:emails',
  SUBMISSION_RATELIMIT: 'submission:ratelimit',
  LOGIN_OTP: 'login:otp',
  LOGIN_COOLDOWN: 'login:cooldown',
  VERIFY_PENDING: 'verify:pending',
  VERIFY_RATELIMIT: 'verify:ratelimit',
};

// ============================================================
// client (lazy init)
// ============================================================

let _client = null;

/**
 * Get the Redis client instance
 * @returns {Redis}
 */
function getClient() {
  if (!_client) {
    _client = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null; // give up reconnecting
        return Math.min(times * 200, 2000);
      },
      lazyConnect: false,
    });

    _client.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });

    _client.on('connect', () => {
      console.log('[redis] Connected to Redis');
    });
  }
  return _client;
}

// ============================================================
// authorized emails (Set)
// ============================================================

/**
 * Check whether an email is authorized
 */
async function isAuthorized(email) {
  const client = getClient();
  return (await client.sismember(KEY_PREFIX.AUTHORIZED_EMAILS, email.toLowerCase())) === 1;
}

/**
 * Add an email to the authorized set
 */
async function addAuthorized(email) {
  const client = getClient();
  return client.sadd(KEY_PREFIX.AUTHORIZED_EMAILS, email.toLowerCase());
}

/**
 * Get all authorized emails
 */
async function getAllAuthorized() {
  const client = getClient();
  return client.smembers(KEY_PREFIX.AUTHORIZED_EMAILS);
}

// ============================================================
// shared rate limit for submissions / sign-in / verification
// ============================================================

/**
 * Get the current counter
 */
async function getSubmissionRateLimit(email) {
  const client = getClient();
  const val = await client.get(`${KEY_PREFIX.SUBMISSION_RATELIMIT}:${email.toLowerCase()}`);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Increment the counter and set its TTL
 */
async function incrSubmissionRateLimit(email, windowSeconds) {
  const client = getClient();
  const key = `${KEY_PREFIX.SUBMISSION_RATELIMIT}:${email.toLowerCase()}`;
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, windowSeconds);
  }
  return count;
}

/**
 * Clear the shared rate-limit counter
 */
async function clearSubmissionRateLimit(email) {
  const client = getClient();
  return client.del(`${KEY_PREFIX.SUBMISSION_RATELIMIT}:${email.toLowerCase()}`);
}

// ============================================================
// sign-in OTP
// ============================================================

async function setLoginOtp(email, code, ttlSeconds) {
  const client = getClient();
  return client.set(`${KEY_PREFIX.LOGIN_OTP}:${email.toLowerCase()}`, code, 'EX', ttlSeconds);
}

async function getLoginOtp(email) {
  const client = getClient();
  return client.get(`${KEY_PREFIX.LOGIN_OTP}:${email.toLowerCase()}`);
}

async function delLoginOtp(email) {
  const client = getClient();
  return client.del(`${KEY_PREFIX.LOGIN_OTP}:${email.toLowerCase()}`);
}

// ============================================================
// sign-in cooldown
// ============================================================

async function setLoginCooldown(email, ttlSeconds) {
  const client = getClient();
  return client.set(`${KEY_PREFIX.LOGIN_COOLDOWN}:${email.toLowerCase()}`, '1', 'EX', ttlSeconds);
}

async function hasLoginCooldown(email) {
  const client = getClient();
  return (await client.exists(`${KEY_PREFIX.LOGIN_COOLDOWN}:${email.toLowerCase()}`)) === 1;
}

async function delLoginCooldown(email) {
  const client = getClient();
  return client.del(`${KEY_PREFIX.LOGIN_COOLDOWN}:${email.toLowerCase()}`);
}

// ============================================================
// verification codes (submission verification)
// ============================================================

async function setVerifyCode(code, senderEmail, ttlSeconds) {
  const client = getClient();
  return client.set(`${KEY_PREFIX.VERIFY_PENDING}:${code}`, senderEmail.toLowerCase(), 'EX', ttlSeconds);
}

async function getVerifyCodeSender(code) {
  const client = getClient();
  return client.get(`${KEY_PREFIX.VERIFY_PENDING}:${code}`);
}

async function delVerifyCode(code) {
  const client = getClient();
  return client.del(`${KEY_PREFIX.VERIFY_PENDING}:${code}`);
}

// ============================================================
// verification rate limit (email verification only)
// ============================================================

async function getVerifyRateLimit(email) {
  const client = getClient();
  const val = await client.get(`${KEY_PREFIX.VERIFY_RATELIMIT}:${email.toLowerCase()}`);
  return val ? parseInt(val, 10) : 0;
}

async function incrVerifyRateLimit(email, windowSeconds) {
  const client = getClient();
  const key = `${KEY_PREFIX.VERIFY_RATELIMIT}:${email.toLowerCase()}`;
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, windowSeconds);
  }
  return count;
}

async function delVerifyRateLimit(email) {
  const client = getClient();
  return client.del(`${KEY_PREFIX.VERIFY_RATELIMIT}:${email.toLowerCase()}`);
}

// ============================================================
// alert counter
// ============================================================

async function incrAlertCounter(windowMinutes) {
  const client = getClient();
  const key = 'alert:ratelimit_hits';
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, windowMinutes * 60);
  }
  return count;
}

module.exports = {
  KEY_PREFIX,
  getClient,
  // authorized emails
  isAuthorized,
  addAuthorized,
  getAllAuthorized,
  // shared rate limit
  getSubmissionRateLimit,
  incrSubmissionRateLimit,
  clearSubmissionRateLimit,
  // sign-in OTP
  setLoginOtp,
  getLoginOtp,
  delLoginOtp,
  // sign-in cooldown
  setLoginCooldown,
  hasLoginCooldown,
  delLoginCooldown,
  // verification codes
  setVerifyCode,
  getVerifyCodeSender,
  delVerifyCode,
  // verification rate limit
  getVerifyRateLimit,
  incrVerifyRateLimit,
  delVerifyRateLimit,
  // alerts
  incrAlertCounter,
};
