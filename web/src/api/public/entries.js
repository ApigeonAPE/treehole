/**
 * api/public/entries.js - thread/post API
 *
 * Posting and replying need a JWT; reading is public.
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, optionalAuth } = require('../../auth/jwt');
const { createEntry, createReply, getEntryList, getEntryDetail, isUserBanned } = require('../../db');

// ban check middleware
function banCheck(req, res, next) {
  if (isUserBanned(req.user.uid)) {
    return res.status(403).json({ error: 'Your account is banned' });
  }
  next();
}

// ============================================================
// POST /api/entries - create a thread (JWT)
// ============================================================

router.post('/', authMiddleware, banCheck, (req, res) => {
  const { title, content } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Missing title or content' });
  }
  if (content.length > 200) {
    return res.status(400).json({ error: 'Content must be at most 200 characters' });
  }

  try {
    const result = createEntry(req.user.uid, title, content);
    res.status(201).json({
      entry_id: result.entry_id,
      post_id: result.post_id,
    });
  } catch (err) {
    console.error('[entries] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/entries/:entry_id/replies - reply (JWT)
// ============================================================

router.post('/:entry_id/replies', authMiddleware, banCheck, (req, res) => {
  const { entry_id } = req.params;
  const { content, reply_to_floor } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'Missing content' });
  }
  if (content.length > 200) {
    return res.status(400).json({ error: 'Content must be at most 200 characters' });
  }

  try {
    const result = createReply(entry_id, req.user.uid, content, reply_to_floor || null);
    res.status(201).json({
      entry_id: result.entry_id,
      floor_id: result.floor_id,
      post_id: result.post_id,
    });
  } catch (err) {
    console.error('[entries] reply error:', err);

    if (err.message === 'Entry not found') {
      return res.status(404).json({ error: 'Thread not found' });
    }
    if (err.message.includes('Floor limit')) {
      return res.status(400).json({ error: 'Thread is full (1155 floors max)' });
    }

    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/entries - thread list (public)
// ============================================================

router.get('/', optionalAuth, (req, res) => {
  const { before, limit, q } = req.query;
  const uid = req.user ? req.user.uid : null;

  try {
    const result = getEntryList(before || null, parseInt(limit) || 20, q || null, uid);
    res.json(result);
  } catch (err) {
    console.error('[entries] list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/entries/:entry_id - thread detail (public; is_me needs a JWT)
// ============================================================

router.get('/:entry_id', optionalAuth, (req, res) => {
  const { entry_id } = req.params;
  const uid = req.user ? req.user.uid : null;

  try {
    const entry = getEntryDetail(entry_id, uid);

    if (!entry) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    res.json(entry);
  } catch (err) {
    console.error('[entries] detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
