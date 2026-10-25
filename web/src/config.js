/**
 * config.js - web server configuration loader
 *
 * Reads /app/config.json and deep-merges /app/config.local.json when present.
 */

const fs = require('fs');

const CONFIG_PATH = '/app/config.json';
const LOCAL_CONFIG_PATH = '/app/config.local.json';

let _config = null;

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (key.startsWith('_')) continue;
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

function loadConfig() {
  if (_config) return _config;

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  _config = JSON.parse(raw);

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

function getConfig() {
  return loadConfig();
}

function getServerConfig() {
  return loadConfig().server;
}

function getJwtConfig() {
  return loadConfig().jwt;
}

function getWebServerConfig() {
  return loadConfig().web_server;
}

function getAdminConfig() {
  return loadConfig().admin || {};
}

function getSmtpConfig() {
  return loadConfig().smtp;
}

function getAddresses() {
  return loadConfig().addresses;
}

function getRatelimitConfig() {
  return loadConfig().ratelimit;
}

function getVerificationConfig() {
  return loadConfig().verification;
}

function getAuthConfig() {
  return loadConfig().auth;
}

function getTimezone() {
  return loadConfig().server.timezone || '+8';
}

function getSiteTitle() {
  return loadConfig().server.site_title || 'Treehole';
}

function getVerifyInstructions() {
  return loadConfig().server.verify_instructions || 'Send the verification code from a trusted domain to {verify_address}';
}

// ============================================================
// outbound provider chain / quota
// ============================================================

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
      const detail = [...new Set(order)]
        .map((name) => `${name}(${name === 'brevo' ? 'enabled/api_key' : name === 'mailgun' ? 'enabled/api_key' : 'host'} incomplete)`)
        .join(', ');
      throw new Error(`mail.order has no usable provider: ${detail}`);
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
  getJwtConfig,
  getWebServerConfig,
  getAdminConfig,
  getSmtpConfig,
  getMailConfig,
  getAddresses,
  getRatelimitConfig,
  getVerificationConfig,
  getAuthConfig,
  getTimezone,
  getSiteTitle,
  getVerifyInstructions,
};
