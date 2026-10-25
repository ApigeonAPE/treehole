/**
 * api/admin/index.js - admin API
 *
 * Publicly reachable (/api/admin); requires Authorization: Bearer <admin.token>.
 * Completely separate from the internal_token used by Haraka.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getAdminConfig } = require('../../config');

function tokenEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function clientIp(req) {
  // Fastly sends Fastly-Client-IP; fall back to X-Real-IP / XFF / socket
  const fastly = req.headers['fastly-client-ip'];
  if (fastly) return String(fastly).trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function adminAuth(req, res, next) {
  const cfg = getAdminConfig();
  res.set('Cache-Control', 'no-store');

  const start = Date.now();
  res.on('finish', () => {
    console.log(`[admin] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ip=${clientIp(req)}`);
  });

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const token = bearer || req.headers['x-admin-token'] || '';
  const configured = cfg.token && !cfg.token.startsWith('change-me');

  if (!configured || !tokenEquals(token, cfg.token)) {
    console.warn(`[admin] auth failed ${req.method} ${req.originalUrl} ip=${clientIp(req)}`);
    return res.status(403).json({ error: 'Forbidden: invalid admin token' });
  }

  next();
}

router.use(adminAuth);

// ============================================================
// Admin API
// ============================================================

router.post('/hide/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id.length === 4) { require('../../db').hideEntry(id); }
    else if (id.length === 6) { require('../../db').hidePost(id); }
    else return res.status(400).json({ error: 'ID must be 4 or 6 characters' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/unhide/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id.length === 4) { require('../../db').unhideEntry(id); }
    else if (id.length === 6) { require('../../db').unhidePost(id); }
    else return res.status(400).json({ error: 'ID must be 4 or 6 characters' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/del/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id.length === 4) { require('../../db').deleteEntry(id); }
    else if (id.length === 6) { require('../../db').deletePost(id); }
    else return res.status(400).json({ error: 'ID must be 4 or 6 characters' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ban', (req, res) => {
  try {
    require('../../db').banUser(req.body.uid, req.body.days || null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/unban', (req, res) => {
  try {
    require('../../db').unbanUser(req.body.uid);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/whois/:id', (req, res) => {
  try {
    const d = require('../../db').getDb();
    const { id } = req.params;
    let row;
    if (id.length === 4) row = d.prepare('SELECT op_uid as uid FROM entries WHERE id = ?').get(id);
    else if (id.length === 6) row = d.prepare('SELECT uid FROM posts WHERE id = ?').get(id);
    else return res.status(400).json({ error: 'ID must be 4 or 6 characters' });
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ uid: row.uid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/history', (req, res) => {
  try {
    const d = require('../../db').getDb();
    const { uid } = req.body;
    const user = d.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const entries = d.prepare('SELECT id, title, created_at FROM entries WHERE op_uid = ? ORDER BY created_at DESC').all(uid);
    const replies = d.prepare("SELECT id, substr(content,1,60) as content, created_at FROM posts WHERE uid = ? AND floor_id != '00' ORDER BY created_at DESC").all(uid);
    res.json({ uid, entries, replies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// outbound quota usage for today
// ============================================================

router.get('/mail-stats', async (req, res) => {
  try {
    const { getMailUsage } = require('../../mail/mailer');
    res.json(await getMailUsage());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
