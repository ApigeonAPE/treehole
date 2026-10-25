'use strict';

/**
 * transports.js - outbound mail transport (Mailgun / Brevo HTTP; SMTP injected by callers)
 *
 * Design:
 *   - one implementation shared by web and Haraka (mounted at /app/mailcore)
 *   - no external deps: Node built-ins only; the Redis client is injected
 *   - quota aware: splits by remaining share of each provider's daily cap and reserves headroom for critical mail
 *
 * Callers provide:
 *   deps.store     createRedisStore(redis) or equivalent (omitted = no quota)
 *   deps.smtpSend  async (msg, providerCfg) => { id }
 *
 * Message shape:
 *   { from: { name, email }, to, subject, text, replyTo: { email } | null,
 *     attachments: [{ filename, contentType, path | content }],
 *     priority: 'critical' | 'normal' }
 */

const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 8000;
const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60;

// Brevo attachment extension whitelist (from their docs); other extensions are renamed or skipped
const BREVO_EXTENSIONS = new Set([
  'xlsx', 'xls', 'ods', 'docx', 'docm', 'doc', 'csv', 'pdf', 'txt', 'gif', 'jpg', 'jpeg',
  'png', 'tif', 'tiff', 'rtf', 'bmp', 'cgm', 'css', 'shtml', 'html', 'htm', 'zip', 'xml',
  'ppt', 'pptx', 'tar', 'ez', 'ics', 'mobi', 'msg', 'pub', 'eps', 'odt', 'mp3', 'm4a',
  'm4v', 'wma', 'ogg', 'flac', 'wav', 'aif', 'aifc', 'aiff', 'mp4', 'mov', 'avi', 'mkv',
  'mpeg', 'mpg', 'wmv', 'pkpass', 'xlsm',
]);

// ============================================================
// error types
// ============================================================

class MailError extends Error {
  constructor(reason, attempts) {
    const detail = (attempts || [])
      .map((a) => `${a.provider}:${a.reason || a.status || (a.ok ? 'ok' : 'error')}`)
      .join(', ');
    super(`mail ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'MailError';
    this.reason = reason;
    this.attempts = attempts || [];
  }
}

class ProviderError extends Error {
  /**
   * @param {string} provider
   * @param {number} status HTTP status, 0 for network errors
   * @param {string} message
   * @param {{network?: boolean, timeout?: boolean, definiteFailure?: boolean}} [opts]
   */
  constructor(provider, status, message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.network = !!opts.network;
    this.timeout = !!opts.timeout;
    // only definite non-delivery rolls back the quota; timeouts / 5xx keep it (may have been accepted)
    this.definiteFailure = opts.definiteFailure !== undefined
      ? opts.definiteFailure
      : (this.network ? !this.timeout : (status >= 400 && status < 500 && status !== 429));
  }
}

/** The provider cannot handle this message (e.g. Brevo rejects .asc); skip without marking it down */
class ProviderSkip extends Error {
  constructor(provider, reason) {
    super(reason);
    this.name = 'ProviderSkip';
    this.provider = provider;
  }
}

// ============================================================
// helpers
// ============================================================

function truncate(value, length) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > length ? `${s.slice(0, length)}…` : s;
}

function sanitizeSubject(subject) {
  return String(subject == null ? '' : subject).replace(/[\r\n]+/g, ' ').trim();
}

function formatFromHeader(from) {
  const name = (from && from.name ? String(from.name) : 'Treehole').trim() || 'Treehole';
  return `${name} <${from.email}>`;
}

function recipientDomain(to) {
  const at = String(to || '').lastIndexOf('@');
  return at < 0 ? '-' : String(to).slice(at + 1).toLowerCase();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text -> minimal HTML (line breaks preserved, http(s) auto-linked) for Brevo htmlContent */
function buildHtml(text) {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}">${m}</a>`);
  return `<div style="white-space:pre-wrap;font-family:inherit;color:inherit">${linked}</div>`;
}

/** Current date (YYYY-MM-DD) in the given timezone, used to bucket daily quotas */
function todayInTz(timeZone) {
  const tz = timeZone || 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
  const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function readAttachment(att) {
  if (att && att.content) {
    return Buffer.isBuffer(att.content) ? att.content : Buffer.from(String(att.content));
  }
  if (att && att.path) return fs.readFileSync(att.path);
  throw new ProviderError('attachment', 0, `attachment has neither path nor content: ${att && att.filename}`, { definiteFailure: true });
}

function brevoAttachmentName(filename, policy) {
  const name = String(filename || 'attachment');
  const idx = name.lastIndexOf('.');
  const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
  if (BREVO_EXTENSIONS.has(ext)) return name;
  if (policy === 'skip') return null;
  return `${name}.txt`;
}

function buildMultipart(fields, attachments, boundary) {
  const chunks = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8',
    ));
  }
  for (const att of attachments) {
    const content = readAttachment(att);
    const contentType = att.contentType || 'application/octet-stream';
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${att.filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`, 'utf8',
    ));
    chunks.push(content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

// ============================================================
// provider adapters
// ============================================================

async function sendMailgun(msg, cfg, timeoutMs) {
  if (!cfg.domain) throw new ProviderError('mailgun', 0, 'mailgun.domain is not configured', { definiteFailure: true });
  const base = String(cfg.apiUrl || 'https://api.mailgun.net/v3').replace(/\/+$/, '');
  const url = `${base}/${cfg.domain}/messages`;

  const fields = new URLSearchParams();
  fields.set('from', formatFromHeader(msg.from));
  fields.set('to', msg.to);
  fields.set('subject', sanitizeSubject(msg.subject));
  fields.set('text', msg.text == null ? '' : String(msg.text));
  if (msg.replyTo && msg.replyTo.email) fields.set('h:Reply-To', msg.replyTo.email);

  const headers = {
    Authorization: 'Basic ' + Buffer.from(`api:${cfg.apiKey}`).toString('base64'),
  };

  let body;
  const attachments = msg.attachments || [];
  if (!attachments.length) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = fields.toString();
  } else {
    const boundary = `----treehole${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    body = buildMultipart(fields, attachments, boundary);
  }

  const resp = await httpRequest(url, { method: 'POST', headers, body }, timeoutMs, 'mailgun');
  const text = await resp.text();
  if (!resp.ok) {
    throw new ProviderError('mailgun', resp.status, `Mailgun ${resp.status}: ${truncate(text, 200)}`);
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* ignore a non-JSON success response */ }
  return { id: json.id || null };
}

async function sendBrevo(msg, cfg, timeoutMs) {
  const url = cfg.apiUrl || 'https://api.brevo.com/v3/smtp/email';
  const text = msg.text == null ? '' : String(msg.text);
  const payload = {
    sender: { name: msg.from.name, email: msg.from.email },
    to: [{ email: msg.to }],
    subject: sanitizeSubject(msg.subject),
    textContent: text,
    htmlContent: buildHtml(text),
  };
  if (msg.replyTo && msg.replyTo.email) payload.replyTo = { email: msg.replyTo.email };
  if (Array.isArray(cfg.tags) && cfg.tags.length) payload.tags = cfg.tags;

  const attachments = [];
  for (const att of (msg.attachments || [])) {
    const name = brevoAttachmentName(att.filename, cfg.attachmentFallback || 'rename');
    if (name === null) throw new ProviderSkip('brevo', `attachment extension not supported: ${att.filename}`);
    attachments.push({ name, content: readAttachment(att).toString('base64') });
  }
  if (attachments.length) payload.attachment = attachments;

  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs, 'brevo');

  const bodyText = await resp.text();
  if (resp.status !== 200 && resp.status !== 201 && resp.status !== 202) {
    let code = '';
    try { code = JSON.parse(bodyText).code || ''; } catch (e) { /* not JSON */ }
    throw new ProviderError('brevo', resp.status, `Brevo ${resp.status}${code ? ` ${code}` : ''}: ${truncate(bodyText, 200)}`);
  }
  let json = {};
  try { json = bodyText ? JSON.parse(bodyText) : {}; } catch (e) { /* ignore */ }
  return { id: json.messageId || null };
}

async function httpRequest(url, options, timeoutMs, provider) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err && err.name;
    const timeout = name === 'TimeoutError' || name === 'AbortError';
    throw new ProviderError(
      provider,
      0,
      timeout ? `timeout after ${timeoutMs}ms` : (err && err.message) || String(err),
      { network: true, timeout },
    );
  }
}

// ============================================================
// provider selection
// ============================================================

/**
 * Return provider names ordered by priority.
 * - failover: strictly follow the chain order
 * - balanced: descending by remaining share of each cap; uncapped providers (smtp) always last
 * - always skip providers that are down or out of quota (normal mail also respects the critical reserve)
 */
function rankProviders(msg, mailCfg, snapshot) {
  const priority = msg.priority === 'critical' ? 'critical' : 'normal';
  const quota = mailCfg.quota || { enabled: false };
  const used = (snapshot && snapshot.used) || {};
  const down = (snapshot && snapshot.down) || {};
  const candidates = [];

  mailCfg.chain.forEach((name, index) => {
    const provider = mailCfg.providers[name];
    if (!provider || provider.enabled === false) return;
    if (down[name]) return;

    const cap = quota.enabled && name !== 'smtp' ? Number(quota.caps[name]) || 0 : 0;
    if (!cap) {
      candidates.push({ name, index, capped: false, usable: 0, capacity: 1 });
      return;
    }

    const remaining = cap - (Number(used[name]) || 0);
    const reserve = Math.floor(cap * (Number(quota.reserveForCritical) || 0));
    const usable = priority === 'critical' ? remaining : Math.max(0, remaining - reserve);
    const capacity = priority === 'critical' ? cap : cap - reserve;
    if (usable <= 0 || capacity <= 0) return;
    candidates.push({ name, index, capped: true, usable, capacity });
  });

  candidates.sort((a, b) => {
    if (mailCfg.strategy === 'balanced') {
      if (a.capped !== b.capped) return a.capped ? -1 : 1;
      if (a.capped && b.capped) {
        // cross-multiply usable/capacity to avoid floating point error
        const left = a.usable * b.capacity;
        const right = b.usable * a.capacity;
        if (left !== right) return right - left;
      }
    }
    return a.index - b.index;
  });

  return candidates.map((c) => c.name);
}

// ============================================================
// Redis quota ledger
// ============================================================

function createRedisStore(redis) {
  const usedKey = (name, day) => `mail:used:${name}:${day}`;
  const downKey = (name) => `mail:down:${name}`;

  return {
    async snapshot(names, day) {
      if (!names || !names.length) return { used: {}, down: {}, degraded: false };
      const [usedVals, downVals] = await Promise.all([
        redis.mget(...names.map((n) => usedKey(n, day))),
        redis.mget(...names.map((n) => downKey(n))),
      ]);
      const used = {};
      const down = {};
      names.forEach((name, i) => {
        used[name] = Number((usedVals && usedVals[i]) || 0);
        down[name] = !!(downVals && downVals[i] != null);
      });
      return { used, down, degraded: false };
    },

    /**
     * Atomically reserve one slot. INCR is serial, so the cap is never exceeded
     * (a transient +1 that is rolled back is expected).
     */
    async reserve(name, cap, day) {
      const key = usedKey(name, day);
      const used = await redis.incr(key);
      if (used === 1) await redis.expire(key, QUOTA_TTL_SECONDS);
      if (used > cap) {
        await redis.decr(key);
        return { ok: false, used: used - 1 };
      }
      return { ok: true, used };
    },

    async release(name, day) {
      const key = usedKey(name, day);
      const used = Number((await redis.get(key)) || 0);
      if (used > 0) await redis.decr(key);
    },

    async markDown(name, ttlSeconds) {
      await redis.set(downKey(name), '1', 'EX', Math.max(10, Number(ttlSeconds) || DEFAULT_COOLDOWN_SECONDS));
    },

    async clearDown(name) {
      await redis.del(downKey(name));
    },
  };
}

// ============================================================
// main entry
// ============================================================

function quotaDay(mailCfg) {
  return todayInTz((mailCfg.quota && mailCfg.quota.resetTimezone) || 'UTC');
}

function warnThreshold(log, name, used, cap) {
  if (!cap) return;
  for (const ratio of [0.8, 0.95]) {
    if (used === Math.max(1, Math.ceil(cap * ratio))) {
      log.warn(`[mail] quota_warn provider=${name} used=${used}/${cap}`);
    }
  }
}

/**
 * Send using the mail config; returns { provider, id, attempts } on success.
 * @param {object} msg
 * @param {object} mailCfg result of getMailConfig()
 * @param {{store?: object, smtpSend?: Function, log?: object}} deps
 */
async function sendWithFallback(msg, mailCfg, deps = {}) {
  const store = deps.store || null;
  const log = deps.log || console;
  const timeoutMs = Math.max(1000, Number(mailCfg.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const attempts = [];
  const day = quotaDay(mailCfg);

  let snapshot = { used: {}, down: {}, degraded: !store };
  if (store) {
    try {
      snapshot = await store.snapshot(mailCfg.chain, day);
    } catch (err) {
      log.warn(`[mail] quota_store_unavailable err="${truncate(err && err.message, 120)}" (fail-open)`);
      snapshot = { used: {}, down: {}, degraded: true };
    }
  }

  const ranked = rankProviders(msg, mailCfg, snapshot);
  if (!ranked.length) throw new MailError('quota_exhausted', attempts);

  for (const name of ranked) {
    const provider = mailCfg.providers[name];
    let reserved = false;

    if (store && !snapshot.degraded && mailCfg.quota && mailCfg.quota.enabled && name !== 'smtp') {
      const cap = Number(mailCfg.quota.caps[name]) || 0;
      try {
        const r = await store.reserve(name, cap, day);
        if (!r || !r.ok) {
          attempts.push({ provider: name, ok: false, reason: 'quota' });
          log.warn(`[mail] skip provider=${name} reason=quota used=${r ? r.used : '?'}/${cap}`);
          continue;
        }
        reserved = true;
        warnThreshold(log, name, r.used, cap);
      } catch (err) {
        log.warn(`[mail] quota_reserve_failed provider=${name} err="${truncate(err && err.message, 120)}" (fail-open)`);
      }
    }

    const startedAt = Date.now();
    try {
      let result;
      if (name === 'smtp') {
        if (typeof deps.smtpSend !== 'function') {
          throw new ProviderError('smtp', 0, 'smtpSend was not injected', { definiteFailure: true });
        }
        result = await deps.smtpSend(msg, provider);
      } else if (name === 'mailgun') {
        result = await sendMailgun(msg, provider, timeoutMs);
      } else if (name === 'brevo') {
        result = await sendBrevo(msg, provider, timeoutMs);
      } else {
        throw new ProviderError(name, 0, `unknown provider: ${name}`, { definiteFailure: true });
      }

      const ms = Date.now() - startedAt;
      attempts.push({ provider: name, ok: true, id: result && result.id });
      if (store) {
        try { await store.clearDown(name); } catch (e) { /* a health-state failure must not affect the send result */ }
      }
      log.log(`[mail] sent provider=${name} to=${recipientDomain(msg.to)} id=${(result && result.id) || '-'} ms=${ms}`);
      return { provider: name, id: (result && result.id) || null, attempts };
    } catch (err) {
      const ms = Date.now() - startedAt;

      if (err instanceof ProviderSkip) {
        attempts.push({ provider: name, ok: false, reason: 'skipped', error: err.message });
        if (reserved && store) { try { await store.release(name, day); } catch (e) { /* ignore */ } }
        log.warn(`[mail] skip provider=${name} reason=${truncate(err.message, 120)}`);
        continue;
      }

      const status = err && err.status;
      attempts.push({ provider: name, ok: false, status, error: err && err.message });
      log.warn(`[mail] fail provider=${name} status=${status || '-'} ms=${ms} err="${truncate(err && err.message, 160)}"`);

      if (store) {
        try { await store.markDown(name, (mailCfg.health && mailCfg.health.cooldownSeconds) || DEFAULT_COOLDOWN_SECONDS); }
        catch (e) { /* ignore */ }
      }
      if (reserved && store && err && err.definiteFailure) {
        try { await store.release(name, day); } catch (e) { /* ignore */ }
      }
    }
  }

  throw new MailError('all_failed', attempts);
}

module.exports = {
  sendWithFallback,
  sendMailgun,
  sendBrevo,
  rankProviders,
  createRedisStore,
  buildHtml,
  todayInTz,
  quotaDay,
  MailError,
  ProviderError,
  ProviderSkip,
  DEFAULT_TIMEOUT_MS,
};
