/**
 * mail/mailer.js - web server mail delivery
 *
 * The chain is resolved by config.getMailConfig() (Mailgun / Brevo HTTP APIs are
 * implemented once in ./transports); SMTP (Nodemailer) is injected as the fallback.
 */

const nodemailer = require('nodemailer');
const Mustache = require('mustache');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const { getMailConfig, getSmtpConfig, getAddresses, getServerConfig } = require('../config');
const { sendWithFallback, createRedisStore, todayInTz } = require('./transports');

const TEMPLATE_DIR = process.env.MAIL_TEMPLATE_DIR || '/app/templates';

let _transporter = null;
let _store = null;

function formatFrom(from) {
  const name = (from.name || 'Treehole').trim() || 'Treehole';
  return `${name} <${from.email}>`;
}

// ============================================================
// SMTP channel (last resort in the chain)
// ============================================================

function getTransporter() {
  if (!_transporter) {
    const smtp = getSmtpConfig();
    const timeoutMs = getMailConfig().timeoutMs;
    _transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: !!smtp.secure,
      auth: smtp.auth && smtp.auth.user
        ? { user: smtp.auth.user, pass: smtp.auth.pass }
        : undefined,
      requireTLS: false,
      tls: { rejectUnauthorized: false },
      connectionTimeout: timeoutMs,
      socketTimeout: timeoutMs * 2,
    });
    _transporter.verify().catch((err) => {
      console.error('[web:mailer] SMTP transport verify failed:', err.message);
    });
  }
  return _transporter;
}

async function smtpSend(msg) {
  const info = await getTransporter().sendMail({
    from: formatFrom(msg.from),
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    replyTo: msg.replyTo && msg.replyTo.email ? msg.replyTo.email : undefined,
    attachments: (msg.attachments || []).map((att) => ({
      filename: att.filename,
      path: att.path,
      contentType: att.contentType,
    })),
  });
  return { id: info && info.messageId ? info.messageId : null };
}

// ============================================================
// quota ledger (Redis)
// ============================================================

function getStore() {
  if (_store) return _store;
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
  });
  redis.on('error', (err) => console.error('[web:mailer] redis error:', err.message));
  _store = createRedisStore(redis);
  return _store;
}

/** Returns null when the ledger is unavailable; transports then fails open. */
function safeStore() {
  try {
    return getStore();
  } catch (err) {
    console.error('[web:mailer] quota store unavailable:', err.message);
    return null;
  }
}

// ============================================================
// templates and sending
// ============================================================

function loadTemplate(name) {
  const filePath = path.join(TEMPLATE_DIR, `${name}.txt`);
  if (!fs.existsSync(filePath)) {
    console.error(`[web:mailer] Template not found: ${filePath}`);
    return `[Template not found: ${name}]`;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function render(name, vars) {
  return Mustache.render(loadTemplate(name), vars);
}

/** Take the leading ## line of the rendered output as the subject */
function renderEmail(name, vars) {
  const rendered = render(name, vars);
  const lines = rendered.split(/\r?\n/);
  let subject = '';
  let text = rendered;
  if (lines.length > 0 && lines[0].match(/^##\s/)) {
    subject = lines[0].replace(/^##\s*/, '').trim();
    text = lines.slice(1).join('\n').trim();
  }
  return { subject, text };
}

/** Single send entry point: walks the provider chain */
async function dispatchMail({ from, to, subject, text, priority = 'critical' }) {
  const addresses = getAddresses();
  const server = getServerConfig();
  const msg = {
    from: { name: server.name, email: from || addresses.noreply },
    to,
    subject,
    text,
    replyTo: null,
    attachments: [],
    priority,
  };
  return sendWithFallback(msg, getMailConfig(), { store: safeStore(), smtpSend });
}

async function sendLoginOtp(to, code) {
  const addresses = getAddresses();
  const server = getServerConfig();

  const { subject, text } = renderEmail('login_otp', {
    server_name: server.name,
    code,
  });

  return dispatchMail({
    from: addresses.noreply,
    to,
    subject: subject || `[${server.name}] Sign-in code`,
    text,
    priority: 'critical',
  });
}

async function sendBindEmailCode(to, code) {
  const addresses = getAddresses();
  const server = getServerConfig();

  const { subject, text } = renderEmail('bind_email_code', {
    server_name: server.name,
    code,
  });

  return dispatchMail({
    from: addresses.noreply,
    to,
    subject: subject || `[${server.name}] Email binding code`,
    text,
    priority: 'critical',
  });
}

// ============================================================
// ops: current quota usage
// ============================================================

async function getMailUsage() {
  const cfg = getMailConfig();
  const day = todayInTz(cfg.quota.resetTimezone);
  let snapshot = { used: {}, down: {} };
  let degraded = false;
  try {
    snapshot = await getStore().snapshot(cfg.chain, day);
  } catch (err) {
    degraded = true;
    console.error('[web:mailer] quota snapshot failed:', err.message);
  }

  const providers = {};
  for (const name of cfg.chain) {
    const cap = cfg.quota.enabled && name !== 'smtp' ? (cfg.quota.caps[name] || null) : null;
    providers[name] = {
      used: snapshot.used[name] || 0,
      cap,
      reserve: cap ? Math.floor(cap * cfg.quota.reserveForCritical) : null,
      down: !!snapshot.down[name],
    };
  }

  return {
    date: day,
    timezone: cfg.quota.resetTimezone,
    strategy: cfg.strategy,
    quota_enabled: cfg.quota.enabled,
    degraded,
    providers,
  };
}

module.exports = {
  getTransporter,
  sendLoginOtp,
  sendBindEmailCode,
  getMailUsage,
};
