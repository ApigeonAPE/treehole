/**
 * auth/jwt.js - JWT signing and verification
 */

const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../config');

/**
 * Sign a JWT
 * @param {object} payload - { uid, email }
 * @returns {string} JWT token
 */
function signToken(payload) {
  const cfg = getJwtConfig();
  return jwt.sign(
    {
      uid: payload.uid,
      email: payload.email,
      iat: Math.floor(Date.now() / 1000),
    },
    cfg.secret,
    { expiresIn: cfg.expires_in_seconds },
  );
}

/**
 * Verify a JWT; returns the payload or null
 * @param {string} token
 * @returns {object|null} { uid, email, iat, exp }
 */
function verifyToken(token) {
  const cfg = getJwtConfig();
  try {
    return jwt.verify(token, cfg.secret);
  } catch (err) {
    return null;
  }
}

/**
 * Extract the token: cookie first, then Authorization: Bearer
 * (authMiddleware and optionalAuth must share this logic,
 *  otherwise cookie-authenticated users have no identity on optionalAuth routes)
 * @param {object} req - Express request
 * @returns {string} token or an empty string
 */
function extractToken(req) {
  if (req.cookies && req.cookies.token) return req.cookies.token;

  const authHeader = req.headers && req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return '';
}

/**
 * Express middleware - JWT auth
 * Extract and verify the token from a cookie or Authorization: Bearer
 */
function authMiddleware(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

/**
 * Express middleware - optional JWT auth
 * Parse the token when present (cookie or Bearer); always continue
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}

module.exports = {
  signToken,
  verifyToken,
  extractToken,
  authMiddleware,
  optionalAuth,
};
