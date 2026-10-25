/**
 * api.js - fetch wrapper with automatic JWT injection
 */

import { getToken, logout } from './auth';

const BASE = '';

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  // 401 means the token expired; clear the session silently
  if (res.status === 401) {
    logout();
    throw new Error('Sign-in required');
  }

  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.error || message;
    } catch {}
    throw new Error(message);
  }

  return res.json();
}

// ============================================================
// public config (no auth)
// ============================================================

export function getPublicConfig() {
  return request('/api/public-config');
}

// ============================================================
// Auth API
// ============================================================

export function checkAuthStatus(email) {
  return request(`/api/auth/status?email=${encodeURIComponent(email)}`);
}

export function requestLoginCode(email) {
  return request('/api/auth/request-login-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function verifyLoginCode(email, code) {
  return request('/api/auth/verify-login-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
}

export function requestVerifyCode(email) {
  return request('/api/auth/request-verify-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function checkVerified(email) {
  return request(`/api/auth/check-verified?email=${encodeURIComponent(email)}`);
}

// ============================================================
// Entries API
// ============================================================

export function getEntries(before, limit = 20, query) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  if (query) params.set('q', query);
  return request(`/api/entries?${params.toString()}`);
}

export function getEntryDetail(entryId) {
  return request(`/api/entries/${entryId}`);
}

export function createEntry(title, content) {
  return request('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ title, content }),
  });
}

export function createReply(entryId, content, replyToFloor) {
  return request(`/api/entries/${entryId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ content, reply_to_floor: replyToFloor || null }),
  });
}

// ============================================================
// User API
// ============================================================

export function getUserPosts() {
  return request('/api/user/posts');
}

export function getUserReplies() {
  return request('/api/user/replies');
}

export function getUserProfile() {
  return request('/api/user/profile');
}

// ============================================================
// Favorites API
// ============================================================

export function toggleFavorite(entryId) {
  return request(`/api/user/favorites/${entryId}`, { method: 'POST' });
}

export function getUserFavorites() {
  return request('/api/user/favorites');
}

export function checkFavorites(ids) {
  return request('/api/user/favorites-check', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}
