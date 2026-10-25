/**
 * config.js - global configuration loader
 *
 * Reads /app/config.json and deep-merges /app/config.local.json when present.
 * The Haraka container mounts config.json read-only.
 */

const fs = require('fs');

const CONFIG_PATH = '/app/config.json';
const LOCAL_CONFIG_PATH = '/app/config.local.json';

let _config = null;

/**
 * Deep-merge objects (local overrides base)
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (key.startsWith('_')) continue; // skip metadata keys such as _comment
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      base[key] !== null &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Load and cache the configuration file
 * @returns {object} configuration object
 */
function loadConfig() {
  if (_config) return _config;

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  _config = JSON.parse(raw);

  // local development overrides
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    const localRaw = fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8');
    const localConfig = JSON.parse(localRaw);
    _config = deepMerge(_config, localConfig);
    console.log('[config] Merged config.local.json overrides');
  }

  // generate a JWT secret when empty or a placeholder
  if (!_config.jwt || !_config.jwt.secret || _config.jwt.secret.startsWith('change-me')) {
    const crypto = require('crypto');
    _config.jwt = _config.jwt || {};
    _config.jwt.secret = crypto.randomBytes(32).toString('hex');
    console.log('[config] Auto-generated JWT secret');
  }

  return _config;
}

/**
 * Get the full configuration
 */
function getConfig() {
  return loadConfig();
}

/**
 * Get the server section
 */
function getServerConfig() {
  return loadConfig().server;
}

/**
 * Get the address section
 */
function getAddresses() {
  return loadConfig().addresses;
}

/**
 * Get the SMTP section (delivery to opensmtpd)
 */
function getSmtpConfig() {
  return loadConfig().smtp;
}

/**
 * Get the web server section
 */
function getWebServerConfig() {
  return loadConfig().web_server;
}

/**
 * Get the auth section (allowed_domains, match_mode)
 */
function getAuthConfig() {
  return loadConfig().auth;
}

/**
 * Get the rate-limit section
 */
function getRatelimitConfig() {
  return loadConfig().ratelimit;
}

/**
 * Get the verification section
 */
function getVerificationConfig() {
  return loadConfig().verification;
}

/**
 * Get the webhook section
 */
function getTargetConfig() {
  return loadConfig().target;
}

/**
 * Get the PGP section
 */
function getPgpConfig() {
  return loadConfig().pgp;
}

/**
 * Get the alert section
 */
function getAlertConfig() {
  return loadConfig().alert;
}

/**
 * Get the timezone
 * @returns {string} e.g. "+8"
 */
function getTimezone() {
  return loadConfig().server?.timezone || '+8';
}

/**
 * Format the current time in the configured timezone with a UTC marker
 * @returns {string} e.g. "2026-07-28 22:30 (UTC+8)"
 */
function formatTimestamp() {
  const tz = getTimezone();
  const offset = parseInt(tz, 10) || 0;
  const utc = new Date();
  const local = new Date(utc.getTime() + offset * 3600000);
  const y = local.getUTCFullYear();
  const mo = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  const h = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  const label = `UTC${tz}`;
  return `${y}-${mo}-${d} ${h}:${mi} (${label})`;
}

/**
 * Extract the email domain (lowercase)
 * @param {string} email - email address
 * @returns {string} the domain part
 */
function extractDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return email.slice(at + 1).toLowerCase();
}

/**
 * Check whether a domain is in the trusted list
 * @param {string} domain - domain to check
 * @param {string[]} allowedDomains - trusted domains
 * @param {string} matchMode - "suffix" | "exact"
 * @returns {boolean}
 */
function isDomainAllowed(domain, allowedDomains, matchMode) {
  domain = domain.toLowerCase();
  for (const allowed of allowedDomains) {
    const a = allowed.toLowerCase();
    if (matchMode === 'exact') {
      if (domain === a) return true;
    } else {
      // suffix: domain ends with allowed, or matches exactly
      if (domain === a || domain.endsWith('.' + a)) return true;
    }
  }
  return false;
}

/**
 * Resolve the mail configuration (provider chain, quota, timeouts).
 * Without a mail section keep the old behaviour: mailgun when a key is set, otherwise smtp.
 * @returns {{chain: string[], strategy: string, timeoutMs: number,
 *            quota: object, health: object, providers: object}}
 */
function getMailConfig() {
  const c = loadConfig();
  const mail = c.mail || {};
  const mailgun = c.mailgun || {};
  const smtp = c.smtp || {};
  const brevo = mail.brevo || {};

  const providers = {
    mailgun: {
      enabled: !!(mailgun.enabled && mailgun.api_key),
      apiKey: mailgun.api_key || '',
      domain: mailgun.domain || '',
      apiUrl: mailgun.api_url || 'https://api.mailgun.net/v3',
    },
    brevo: {
      enabled: !!(brevo.enabled !== false && brevo.api_key),
      apiKey: brevo.api_key || '',
      apiUrl: brevo.api_url || 'https://api.brevo.com/v3/smtp/email',
      tags: Array.isArray(brevo.tags) ? brevo.tags : [],
      attachmentFallback: brevo.attachment_fallback === 'skip' ? 'skip' : 'rename',
    },
    smtp: {
      enabled: !!smtp.host,
      host: smtp.host || '',
      port: smtp.port || 25,
      secure: !!smtp.secure,
      auth: smtp.auth && smtp.auth.user ? smtp.auth : null,
    },
  };

  const order = Array.isArray(mail.order) ? mail.order : null;
  let chain;
  if (order && order.length) {
    const unknown = order.filter((name) => !providers[name]);
    if (unknown.length) {
      throw new Error(`mail.order contains unknown provider: ${unknown.join(', ')}`);
    }
    chain = [...new Set(order)].filter((name) => providers[name].enabled);
    if (!chain.length) {
      throw new Error(`mail.order has no usable provider: ${[...new Set(order)].join(', ')}`);
    }
  } else {
    chain = (mailgun.enabled && mailgun.api_key) ? ['mailgun'] : ['smtp'];
    chain = chain.filter((name) => providers[name].enabled);
    if (!chain.length) chain = ['smtp'];
  }

  const quota = mail.quota || {};
  const caps = quota.caps || {};
  const quotaEnabled = !!quota.enabled;
  if (quotaEnabled) {
    for (const name of chain) {
      if (name === 'smtp') continue;
      if (!(Number(caps[name]) > 0)) {
        throw new Error(`mail.quota.enabled=true requires a positive integer mail.quota.caps.${name}`);
      }
    }
  }

  return {
    chain,
    strategy: mail.strategy === 'balanced' ? 'balanced' : 'failover',
    timeoutMs: Math.max(1000, Number(mail.timeout_ms) || 8000),
    quota: {
      enabled: quotaEnabled,
      resetTimezone: quota.reset_timezone || 'UTC',
      reserveForCritical: Math.min(0.9, Math.max(0, Number(quota.reserve_for_critical) || 0)),
      caps: {
        mailgun: Number(caps.mailgun) || 0,
        brevo: Number(caps.brevo) || 0,
      },
    },
    health: {
      cooldownSeconds: Math.max(10, Number(mail.health && mail.health.cooldown_seconds) || 60),
    },
    providers,
  };
}

module.exports = {
  loadConfig,
  getConfig,
  getServerConfig,
  getAddresses,
  getSmtpConfig,
  getWebServerConfig,
  getAuthConfig,
  getRatelimitConfig,
  getVerificationConfig,
  getTargetConfig,
  getPgpConfig,
  getAlertConfig,
  getMailConfig,
  extractDomain,
  isDomainAllowed,
  getTimezone,
  formatTimestamp,
};
