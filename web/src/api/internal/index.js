/**
 * api/internal/index.js - Haraka <-> web server interface
 *
 * Reachable only on the container network (9000); Caddy returns 404 for /api/internal/* publicly.
 * Every endpoint requires X-Internal-Token.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getWebServerConfig } = require('../../config');
const { findOrCreateUser, getAllAuthorizedEmails, validateId, isUserBanned, getBannedInfo } = require('../../db');

// ============================================================
// internal token auth middleware
// ============================================================

function tokenEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function internalAuth(req, res, next) {
  const cfg = getWebServerConfig();
  const token = req.headers['x-internal-token'] || '';

  if (!token || !cfg.internal_token || !tokenEquals(token, cfg.internal_token)) {
    return res.status(403).json({ error: 'Forbidden: invalid internal token' });
  }

  next();
}

router.use(internalAuth);

// ============================================================
// POST /api/internal/email-verified
// notify the web server that an email was verified
// ============================================================

router.post('/email-verified', (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const result = findOrCreateUser(email);
    res.json({
      user_id: result.user_id,
      status: result.status,
    });
  } catch (err) {
    console.error('[internal] email-verified error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// GET /api/internal/authorized-emails
// full sync of authorized emails at Haraka startup
// ============================================================

router.get('/authorized-emails', (req, res) => {
  try {
    const emails = getAllAuthorizedEmails();
    res.json({ emails });
  } catch (err) {
    console.error('[internal] authorized-emails error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================
// GET /api/internal/validate-id/:id
// validate a thread/floor ID
// ============================================================

router.get('/validate-id/:id', (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ valid: false, error: 'Missing ID' });
  }

  try {
    const result = validateId(id);
    res.json(result);
  } catch (err) {
    console.error('[internal] validate-id error:', err);
    res.status(500).json({ valid: false, error: 'Internal error' });
  }
});

// ============================================================
// POST /api/internal/submissions
// submission entry point for Haraka
// ============================================================

router.post('/submissions', (req, res) => {
  const { type, title, content, author, entry_id, reply_to_floor } = req.body;

  if (!author) {
    return res.status(400).json({ error: 'Missing required field: author' });
  }
  // Content can be empty (e.g. when body extraction fails)
  const safeContent = content || '';

  if (safeContent.length > 1000) {
    return res.status(400).json({ error: 'content too long; limit is 1000 characters' });
  }

  try {
    // find or create the user
    const user = findOrCreateUser(author);

    // ban check
    if (isUserBanned(user.user_id)) {
      const info = getBannedInfo(user.user_id);
      return res.status(403).json({ error: 'Your account is banned', banned_until: info?.banned_until });
    }

    if (type === 'new') {
      const result = require('../../db').createEntry(user.user_id, title || '(untitled)', safeContent);
      return res.json({ ok: true, entry_id: result.entry_id, floor_id: '00' });
    }

    if (type === 'reply') {
      if (!entry_id) {
        return res.status(400).json({ error: 'Missing entry_id for reply' });
      }
      const result = require('../../db').createReply(entry_id, user.user_id, safeContent, reply_to_floor || null);
      return res.json({ ok: true, entry_id: result.entry_id, floor_id: result.floor_id });
    }

    return res.status(400).json({ error: `Unknown submission type: ${type}` });
  } catch (err) {
    console.error('[internal] submissions error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
