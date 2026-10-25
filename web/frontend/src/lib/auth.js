/**
 * auth.js - JWT token storage
 */

const TOKEN_KEY = 'treehole_token';
const USER_KEY = 'treehole_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser() {
  localStorage.removeItem(USER_KEY);
}

export function isLoggedIn() {
  return !!getToken();
}

export function setBannedUntil(date) {
  localStorage.setItem('treehole_banned', date || '');
}

export function getBannedUntil() {
  return localStorage.getItem('treehole_banned') || null;
}

export function logout() {
  clearToken();
  clearUser();
  localStorage.removeItem('treehole_banned');
}
