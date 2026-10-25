/**
 * api/public/auth.js - authentication API
 *
 * Sign-in flow:
 *   verified email -> request-login-code -> OTP -> verify-login-code -> JWT
 *   unverified email -> request-verify-code -> show code -> user emails verify@ -> check-verified -> sign in again
 */

const express = require('express');
const router = express.Router();
const Redis = require('ioredis');
const { authMiddleware } = require('../../auth/jwt');
const { signToken } = require('../../auth/jwt');
const { sendLoginOtp } = require('../../mail/mailer');
const { findOrCreateUser, getUserIdByEmail, getUserPrimaryEmail, getUserEmails } = require('../../db');
const { getRatelimitConfig, getVerificationConfig, getAuthConfig } = require('../../config');

// Redis client
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
});

// ============================================================
// GET /api/auth/status?email={email}
// email authorization status (trusted domains auto-authorize)
// ============================================================

router.get('/status', async (req, res) => {
  const { email } = req.query;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    let authorized = (await redis.sismember('authorized:emails', email.toLowerCase())) === 1;

    // auto-authorize trusted domains
    if (!authorized) {
      const auth = getAuthConfig();
      const domain = email.toLowerCase().split('@')[1] || '';
      if (isDomainAllowed(domain, auth.allowed_domains, auth.match_mode)) {
        await redis.sadd('authorized:emails', email.toLowerCase());
        // create the user
        const { findOrCreateUser } = require('../../db');
        findOrCreateUser(email);
        authorized = true;
      }
    }

    res.json({ authorized });
  } catch (err) {
    console.error('[auth] status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/auth/request-login-code
// verified email requests a sign-in OTP
// ============================================================

router.post('/request-login-code', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // 1. check whether the email is authorized (trusted domains auto-authorize)
    let isAuthorized = (await redis.sismember('authorized:emails', email.toLowerCase())) === 1;

    if (!isAuthorized) {
      const auth = getAuthConfig();
      const domain = email.toLowerCase().split('@')[1] || '';
      if (isDomainAllowed(domain, auth.allowed_domains, auth.match_mode)) {
        await redis.sadd('authorized:emails', email.toLowerCase());
        const { findOrCreateUser } = require('../../db');
        findOrCreateUser(email);
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(400).json({
        error: 'Email not verified',
        code: 'NOT_AUTHORIZED',
        hint: 'Verify the email first',
      });
    }

    const rl = getRatelimitConfig();

    // 2. rate limit
    const currentCount = await redis.get(`submission:ratelimit:${email.toLowerCase()}`);
    const count = currentCount ? parseInt(currentCount, 10) : 0;

    if (count >= rl.submission.max_attempts) {
      const ttl = await redis.ttl(`submission:ratelimit:${email.toLowerCase()}`);
      const waitMinutes = Math.ceil(ttl / 60);
      return res.status(429).json({
        error: `Too many requests, try again in ${waitMinutes} minutes`,
        retry_after_seconds: ttl,
      });
    }

    // 3. cooldown
    const cooldown = await redis.exists(`login:cooldown:${email.toLowerCase()}`);
    if (cooldown) {
      const ttl = await redis.ttl(`login:cooldown:${email.toLowerCase()}`);
      return res.status(429).json({
        error: `Please wait ${ttl} seconds`,
        retry_after_seconds: ttl,
      });
    }

    // 4. allowed -> generate and send the OTP
    await redis.incr(`submission:ratelimit:${email.toLowerCase()}`);
    await redis.expire(`submission:ratelimit:${email.toLowerCase()}`, rl.submission.window_seconds);

    await redis.set(`login:cooldown:${email.toLowerCase()}`, '1', 'EX', rl.cooldown_seconds);

    const code = generateOtp(6);
    await redis.set(`login:otp:${email.toLowerCase()}`, code, 'EX', 600);

    // send the email
    await sendLoginOtp(email, code);

    res.json({ status: 'code_sent' });
  } catch (err) {
    console.error('[auth] request-login-code error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/auth/verify-login-code
// verify the OTP -> issue a JWT
// ============================================================

router.post('/verify-login-code', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Missing email or code' });
  }

  try {
    // read the OTP from Redis
    const storedCode = await redis.get(`login:otp:${email.toLowerCase()}`);

    if (!storedCode || storedCode !== code) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    // OTP matched -> clear the Redis keys
    await redis.del(`login:otp:${email.toLowerCase()}`);
    await redis.del(`login:cooldown:${email.toLowerCase()}`);
    await redis.del(`submission:ratelimit:${email.toLowerCase()}`);

    // look up the user
    const userId = getUserIdByEmail(email.toLowerCase());
    const uid = userId || findOrCreateUser(email).user_id;

    // issue the JWT
    const token = signToken({ uid, email: email.toLowerCase() });

    // set the persistent cookie (90 days)
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({
      token,
      uid,
      email: email.toLowerCase(),
    });
  } catch (err) {
    console.error('[auth] verify-login-code error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/auth/request-verify-code
// unverified email requests a verification code
// ============================================================

router.post('/request-verify-code', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // 1. check whether it is already authorized (then use the sign-in flow)
    const isAuthorized = (await redis.sismember('authorized:emails', email.toLowerCase())) === 1;
    if (isAuthorized) {
      return res.status(400).json({
        error: 'Email already verified, please sign in',
        code: 'ALREADY_AUTHORIZED',
      });
    }

    const rl = getRatelimitConfig();

    // 2. rate limit
    const currentCount = await redis.get(`submission:ratelimit:${email.toLowerCase()}`);
    const count = currentCount ? parseInt(currentCount, 10) : 0;

    if (count >= rl.submission.max_attempts) {
      const ttl = await redis.ttl(`submission:ratelimit:${email.toLowerCase()}`);
      return res.status(429).json({
        error: `Too many requests, try again in ${Math.ceil(ttl / 60)} minutes`,
        retry_after_seconds: ttl,
      });
    }

    // 3. cooldown
    const cooldown = await redis.exists(`login:cooldown:${email.toLowerCase()}`);
    if (cooldown) {
      const ttl = await redis.ttl(`login:cooldown:${email.toLowerCase()}`);
      return res.status(429).json({
        error: `Please wait ${ttl} seconds`,
        retry_after_seconds: ttl,
      });
    }

    // 4. allowed -> generate the code
    await redis.incr(`submission:ratelimit:${email.toLowerCase()}`);
    await redis.expire(`submission:ratelimit:${email.toLowerCase()}`, rl.submission.window_seconds);

    await redis.set(`login:cooldown:${email.toLowerCase()}`, '1', 'EX', rl.cooldown_seconds);

    const vc = getVerificationConfig();
    const code = generateOtp(vc.code_length);
    await redis.set(`verify:pending:${code}`, email.toLowerCase(), 'EX', vc.code_ttl_seconds);

    const { getAddresses, getVerifyInstructions, getAuthConfig } = require('../../config');
    const addresses = getAddresses();
    const authCfg = getAuthConfig();
    const domains = authCfg.allowed_domains.join('、');
    const instructions = getVerifyInstructions()
      .replace('{verify_address}', addresses.verify)
      .replace('{trusted_domains}', domains);

    res.json({
      status: 'verification_required',
      code,
      instructions,
    });
  } catch (err) {
    console.error('[auth] request-verify-code error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// GET /api/auth/check-verified?email={email}
// poll for verification completion
// ============================================================

router.get('/check-verified', async (req, res) => {
  const { email } = req.query;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const isAuthorized = (await redis.sismember('authorized:emails', email.toLowerCase())) === 1;

    if (isAuthorized) {
      res.json({ status: 'verified', message: 'Verified, go back and sign in' });
    } else {
      res.json({ status: 'pending', message: 'Not verified yet' });
    }
  } catch (err) {
    console.error('[auth] check-verified error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/auth/logout - clear the session cookie
// ============================================================

router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

// ============================================================
// GET /api/auth/me
// current user profile (JWT required)
// ============================================================

router.get('/me', authMiddleware, (req, res) => {
  try {
    const emails = getUserEmails(req.user.uid);
    const primaryEmail = getUserPrimaryEmail(req.user.uid);
    const banInfo = require('../../db').getBannedInfo(req.user.uid);

    res.json({
      uid: req.user.uid,
      primary_email: primaryEmail,
      emails,
      banned: banInfo ? banInfo.banned_until : null,
    });
  } catch (err) {
    console.error('[auth] me error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

function isDomainAllowed(domain, allowedDomains, matchMode) {
  domain = domain.toLowerCase();
  for (const allowed of allowedDomains) {
    const a = allowed.toLowerCase();
    if (matchMode === 'exact' ? domain === a : (domain === a || domain.endsWith('.' + a))) {
      return true;
    }
  }
  return false;
}

// ============================================================
// helpers
// ============================================================

function generateOtp(length) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

module.exports = router;
