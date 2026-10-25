/**
 * mailer.js - Haraka mail delivery
 *
 * The delivery chain is resolved by shared/config.getMailConfig():
 *   - Mailgun / Brevo HTTP APIs are implemented once in web/src/mail/transports.js
 *     (mounted into the container at /app/mailcore/transports.js by docker-compose)
 *   - SMTP (Nodemailer -> OpenSMTPD/Mailpit) is the fallback channel
 *
 * Every reply is sent from addresses.noreply.
 */

const nodemailer = require('nodemailer');
const {
  getSmtpConfig, getAddresses, getServerConfig, formatTimestamp,
  getMailConfig,
} = require('./config');

// Templates that must reach the user: sign-in, verification, public-key resend
const CRITICAL_TEMPLATES = new Set([
  'login_otp',
  'verify_required',
  'verify_success',
  'verify_code_expired',
  'verify_format_error',
  'verify_domain_rejected',
  'pgp_decrypt_failed',
]);

let _transporter = null;
let _transports = null;
let _store = null;
let _transportsErrorLogged = false;

function loadTransports() {
  if (_transports) return _transports;
  try {
    // docker-compose mounts web/src/mail at /app/mailcore inside the container
    _transports = require('../../mailcore/transports');
    return _transports;
  } catch (err) {
    if (!_transportsErrorLogged) {
      _transportsErrorLogged = true;
      console.error('[mailer] transports module unavailable (/app/mailcore/transports.js) — check docker-compose mount:', err.message);
    }
    throw err;
  }
}

function formatFrom(from) {
  const name = (from.name || 'Treehole').trim() || 'Treehole';
  return `${name} <${from.email}>`;
}

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

    _transporter.verify().then(() => {
      console.log('[mailer] SMTP transport ready → ' + smtp.host + ':' + smtp.port);
    }).catch((err) => {
      console.error('[mailer] SMTP transport verify failed:', err.message);
    });
  }
  return _transporter;
}

function getStore() {
  if (_store) return _store;
  const redis = require('./redis');
  _store = loadTransports().createRedisStore(redis.getClient());
  return _store;
}

function safeStore() {
  try {
    return getStore();
  } catch (err) {
    console.error('[mailer] quota store unavailable:', err.message);
    return null;
  }
}

/** SMTP channel: unchanged behaviour (including List-Unsubscribe) */
function smtpSend(msg) {
  const addresses = getAddresses();
  const mailOptions = {
    from: formatFrom(msg.from),
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    attachments: (msg.attachments || []).map((att) => ({
      filename: att.filename,
      path: att.path,
      contentType: att.contentType,
    })),
  };
  if (msg.replyTo && msg.replyTo.email) mailOptions.replyTo = msg.replyTo.email;
  if (mailOptions.text) {
    mailOptions.list = { unsubscribe: `mailto:${addresses.postmaster}` };
  }

  return getTransporter().sendMail(mailOptions).then((info) => ({
    id: info && info.messageId ? info.messageId : null,
  }));
}

/**
 * Send a message through the provider chain, falling back on failure
 * @param {object} opts
 * @param {string} [opts.from] - sender address (defaults to noreply)
 * @param {string} [opts.replyTo]
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text
 * @param {object[]} [opts.attachments]
 * @param {'critical'|'normal'} [opts.priority]
 * @returns {Promise<{provider: string, id: string|null}>}
 */
async function sendMail({ from, replyTo, to, subject, text, attachments, priority }) {
  const addresses = getAddresses();
  const server = getServerConfig();

  const msg = {
    from: { name: server.name, email: from || addresses.noreply },
    to,
    subject,
    text: text == null ? '' : text,
    replyTo: replyTo ? { email: replyTo } : null,
    attachments: attachments || [],
    priority: priority === 'critical' ? 'critical' : 'normal',
  };

  return loadTransports().sendWithFallback(msg, getMailConfig(), {
    store: safeStore(),
    smtpSend,
  });
}

/**
 * Reply to the submitter
 * @param {object} connOrTxn - Haraka connection or transaction
 * @param {string} templateName
 * @param {object} vars - template variables; `_sender` overrides auto-detection
 * @param {object[]} attachments
 */
async function replyToSender(connOrTxn, templateName, vars = {}, attachments = []) {
  const { render } = require('./template');

  // prefer vars._sender (mail_from may already be cleared in async callbacks)
  var sender = vars._sender || '';
  delete vars._sender;

  if (!sender) {
    const txn = connOrTxn.transaction || connOrTxn;
    const addr = txn.mail_from;
    if (addr) {
      if (typeof addr.address === 'function') sender = addr.address();
      else if (addr.user && addr.host) sender = addr.user + '@' + addr.host;
      else if (typeof addr === 'string') sender = addr;
      else sender = String(addr);
    }
  }
  sender = sender.toLowerCase().replace(/^<|>$/g, '').trim();

  if (!sender || sender === '<>') {
    console.log('[mailer] Empty sender, cannot reply');
    return null;
  }

  const server = getServerConfig();

  // render the template
  var addresses = getAddresses();
  var tplVars = {
    ...vars,
    server_name: server.name,
    hostname: server.hostname,
    timestamp: formatTimestamp(),
    submit_address: addresses.submit,
    verify_address: addresses.verify,
  };
  var rendered = render(templateName, tplVars);

  // first line starting with ## -> subject
  var subject;
  var text;
  var lines = rendered.split(/\r?\n/);
  if (lines.length > 0 && lines[0].match(/^##\s/)) {
    subject = lines[0].replace(/^##\s*/, '').trim();
    text = lines.slice(1).join('\n').trim();
  } else {
    subject = templateToSubject(templateName, server.name);
    text = rendered.trim();
  }

  // sender is always noreply; Reply-To keeps its original meaning:
  //   success mail -> noreply (replying to it must not create another submission)
  //   PGP decryption failure -> submit (so the user can resend encrypted)
  const from = addresses.noreply;
  const replyTo = templateName === 'pgp_decrypt_failed' ? addresses.submit : addresses.noreply;
  const priority = CRITICAL_TEMPLATES.has(templateName) ? 'critical' : 'normal';

  const info = await sendMail({
    from,
    replyTo,
    to: sender,
    subject,
    text,
    attachments,
    priority,
  });
  console.log(`[mailer] Reply sent to ${sender}: ${templateName} (via=${info.provider} id=${info.id || 'unknown'})`);
  return info;
}

/**
 * Send an alert to the administrator
 * @param {string} templateName
 * @param {object} vars
 */
async function sendAdminAlert(templateName, vars = {}) {
  const server = getServerConfig();
  const { render } = require('./template');

  var addresses = getAddresses();
  var rendered = render(templateName, {
    ...vars,
    server_name: server.name,
    timestamp: formatTimestamp(),
    submit_address: addresses.submit,
    verify_address: addresses.verify,
  });

  // first line starting with ## -> subject
  var subject;
  var text;
  var lines = rendered.split(/\r?\n/);
  if (lines.length > 0 && lines[0].match(/^##\s/)) {
    subject = lines[0].replace(/^##\s*/, '').trim();
    text = lines.slice(1).join('\n').trim();
  } else {
    subject = templateToSubject(templateName, server.name);
    text = rendered.trim();
  }

  return sendMail({
    to: addresses.admin_alert,
    subject,
    text,
    priority: 'normal',
  });
}

/**
 * Derive a subject from the template name
 */
function templateToSubject(templateName, serverName) {
  const subjects = {
    submission_success: `[${serverName}] Submission received`,
    submission_failed: `[${serverName}] Submission failed`,
    verify_required: `[${serverName}] Verify your email`,
    verify_success: `[${serverName}] Verification complete`,
    verify_code_expired: `[${serverName}] Code expired`,
    verify_format_error: `[${serverName}] Invalid code format`,
    verify_domain_rejected: `[${serverName}] Verification rejected`,
    rate_limit: `[${serverName}] Too many requests`,
    reply_invalid_id: `[${serverName}] Invalid reply target`,
    pgp_decrypt_failed: `[${serverName}] PGP decryption failed`,
    login_otp: `[${serverName}] Sign-in code`,
    alert_developer: `[${serverName}] System alert`,
    content_too_long: `[${serverName}] Submission failed: content too long`,
    default: `[${serverName}] Notification`,
  };
  return subjects[templateName] || subjects['default'];
}

module.exports = {
  getTransporter,
  sendMail,
  replyToSender,
  sendAdminAlert,
};
