/**
 * api/public/user.js - user API
 *
 * Every endpoint requires a JWT.
 */

const express = require('express');
const router = express.Router();
const Redis = require('ioredis');
const { authMiddleware } = require('../../auth/jwt');
const {
  getUserEntries, getUserReplies, getUserEmails, getUserPrimaryEmail,
  getUserIdByEmail, getUserFullInfoByEmail, bindEmailToUser, mergeAccounts,
  toggleFavorite, getUserFavorites, checkFavorites,
} = require('../../db');
const { sendBindEmailCode } = require('../../mail/mailer');
const { getRatelimitConfig } = require('../../config');

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
// GET /api/user/posts - my threads
// ============================================================

router.get('/posts', authMiddleware, (req, res) => {
  try {
    const items = getUserEntries(req.user.uid);
    res.json({ items });
  } catch (err) {
    console.error('[user] posts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/user/replies - my replies
// ============================================================

router.get('/replies', authMiddleware, (req, res) => {
  try {
    const items = getUserReplies(req.user.uid);
    res.json({ items });
  } catch (err) {
    console.error('[user] replies error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/user/profile - profile
// ============================================================

router.get('/profile', authMiddleware, (req, res) => {
  try {
    const emails = getUserEmails(req.user.uid);
    const primaryEmail = getUserPrimaryEmail(req.user.uid);

    res.json({
      uid: req.user.uid,
      primary_email: primaryEmail,
      emails,
    });
  } catch (err) {
    console.error('[user] profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/user/request-bind-code - request a bind code
// ============================================================

router.post('/request-bind-code', authMiddleware, async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    // check whether it is already bound to this user
    const existingUid = getUserIdByEmail(email.toLowerCase());
    if (existingUid === req.user.uid) {
      return res.status(400).json({ error: 'This email is already bound to your account' });
    }

    const rl = getRatelimitConfig();

    // cooldown check
    const cooldown = await redis.exists(`bind:cooldown:${req.user.uid}`);
    if (cooldown) {
      const ttl = await redis.ttl(`bind:cooldown:${req.user.uid}`);
      return res.status(429).json({ error: `Please wait ${ttl} seconds`, retry_after_seconds: ttl });
    }

    await redis.set(`bind:cooldown:${req.user.uid}`, '1', 'EX', rl.cooldown_seconds);

    const code = generateOtp(6);
    await redis.set(`bind:code:${email.toLowerCase()}`, JSON.stringify({ code, uid: req.user.uid }), 'EX', 600);

    await sendBindEmailCode(email, code);

    res.json({ status: 'code_sent' });
  } catch (err) {
    console.error('[user] request-bind-code error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/user/bind-email - verify and bind an email
// ============================================================

router.post('/bind-email', authMiddleware, async (req, res) => {
  const { email, code, confirm_merge } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Missing email or code' });
  }

  try {
    // code check
    const stored = await redis.get(`bind:code:${email.toLowerCase()}`);
    if (!stored) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const { code: storedCode, uid: requestUid } = JSON.parse(stored);
    if (storedCode !== code || requestUid !== req.user.uid) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    // check whether the email belongs to another user
    const otherUid = getUserIdByEmail(email.toLowerCase());
    if (otherUid && otherUid !== req.user.uid) {
      // conflict: the email belongs to another account
      if (!confirm_merge) {
        // return the conflict without consuming the code; wait for confirmation
        const otherInfo = getUserFullInfoByEmail(email.toLowerCase());
        return res.json({
          status: 'conflict',
          other_uid: otherUid,
          other_emails: otherInfo ? otherInfo.emails : [],
        });
      }

      // user confirmed the merge
      mergeAccounts(otherUid, req.user.uid);
      await redis.del(`bind:code:${email.toLowerCase()}`);
      await redis.del(`bind:cooldown:${req.user.uid}`);
      return res.json({ status: 'merged', merged_uid: otherUid });
    }

    // no conflict, bind directly
    bindEmailToUser(req.user.uid, email);
    await redis.del(`bind:code:${email.toLowerCase()}`);
    await redis.del(`bind:cooldown:${req.user.uid}`);

    res.json({ status: 'bound', email });
  } catch (err) {
    console.error('[user] bind-email error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// POST /api/user/favorites/:entryId - toggle favorite
// ============================================================

router.post('/favorites/:entryId', authMiddleware, (req, res) => {
  try {
    const result = toggleFavorite(req.user.uid, req.params.entryId);
    res.json(result);
  } catch (err) {
    console.error('[user] favorite toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/user/favorites - favorites
// ============================================================

router.get('/favorites', authMiddleware, (req, res) => {
  try {
    const items = getUserFavorites(req.user.uid);
    res.json({ items });
  } catch (err) {
    console.error('[user] favorites error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/user/favorites-check - batch favorite lookup
// ============================================================

router.post('/favorites-check', authMiddleware, (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.json({});
    const result = checkFavorites(req.user.uid, ids);
    res.json(result);
  } catch (err) {
    console.error('[user] favorites-check error:', err);
    res.status(500).json({ error: err.message });
  }
});

function generateOtp(length) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

module.exports = router;
