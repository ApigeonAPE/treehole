// mail_gateway.js - email-authenticated submission gateway
// hook_data: enable parse_body
// hook_data_post: txn.body is already parsed, use it directly

const redis = require('./shared/redis');
const { getAddresses, getRatelimitConfig, getAuthConfig, getVerificationConfig, getServerConfig, getPgpConfig } = require('./shared/config');
const { replyToSender } = require('./shared/mailer');
const { submitPost, validateId } = require('./shared/poster');
const openpgp = require('openpgp');
const fs = require('fs');

// all replies go through here so Mailgun/template errors cannot become unhandled rejections
function safeReply(conn, template, vars, attachments) {
  return replyToSender(conn, template, vars, attachments).catch(function (e) {
    console.error('[mail_gateway] reply failed: ' + (e.stack || e.message));
  });
}

var BASE34_SET = new Set('0123456789abcdefghjklmnpqrstuvwxyz'.split(''));

function getSender(c) {
  var a = c.transaction && c.transaction.mail_from;
  if (!a) return '';
  if (typeof a.address === 'function') return a.address().toLowerCase();
  if (a.user && a.host) return (a.user + '@' + a.host).toLowerCase();
  return String(a).toLowerCase().replace(/^<|>$/g, '');
}
function atos(a) {
  if (!a) return ''; if (typeof a === 'string') return a.replace(/^<|>$/g, '');
  if (typeof a.address === 'function') return a.address();
  if (a.user && a.host) return a.user + '@' + a.host;
  return String(a).replace(/^<|>$/g, '');
}
function rcptContains(conn, k) {
  var t = getAddresses()[k].toLowerCase();
  var l = (conn.transaction && conn.transaction.rcpt_to) || conn.rcpt_to || [];
  return l.some(function (r) { return atos(r).toLowerCase() === t; });
}
function extractDomain(e) { var at = e.lastIndexOf('@'); return at < 0 ? '' : e.slice(at+1).toLowerCase(); }
function isDomainAllowed(d, list, mode) {
  d = d.toLowerCase();
  for (var i = 0; i < list.length; i++) {
    var a = list[i].toLowerCase();
    if (mode === 'exact' ? d === a : (d === a || d.endsWith('.' + a))) return true;
  }
  return false;
}
function generateCode(n) { var c=''; for (var i=0;i<n;i++)c+=Math.floor(Math.random()*10).toString(); return c; }
function isBase34(s) { return s.split('').every(function(c){return BASE34_SET.has(c);}); }
function getSubject(conn) {
  var h = conn.transaction && conn.transaction.header; if (!h) return '';
  try { var v = h.get_decoded('subject'); if (v) return v; } catch(e) {}
  try { return h.get('subject') || ''; } catch(e) { return ''; }
}

// extract body: prefer text/plain; fall back to text/html stripped of tags; ignore attachments/binary
function getBody(txn) {
  if (!txn || !txn.body) return '';
  var parts = [];
  collectTextParts(txn.body, parts);

  var plain = parts.filter(function (p) { return p.ct.indexOf('text/plain') === 0; });
  if (plain.length) return plain.map(function (p) { return p.text; }).join('\n').trim();

  var html = parts.filter(function (p) { return p.ct.indexOf('text/html') === 0; });
  if (html.length) return stripHtml(html.map(function (p) { return p.text; }).join('\n')).trim();

  return '';
}

function collectTextParts(node, out) {
  if (!node) return;
  var ct = String(node.ct || '').toLowerCase().split(';')[0].trim();
  if (ct.indexOf('text/') === 0 && node.bodytext) {
    var text = typeof node.bodytext === 'string' ? node.bodytext : String(node.bodytext);
    if (text.length > 0) out.push({ ct: ct, text: text });
  }
  if (node.children && node.children.length) {
    for (var i = 0; i < node.children.length; i++) collectTextParts(node.children[i], out);
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; }
    })
    .replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; }
    })
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// hook_queue: tell Haraka the message was accepted, return 250 instead of 451
exports.hook_queue = function (next, connection) {
  return next(OK);
};

exports.register = function () {
  this.hook_data = exports.hook_data;
  this.hook_data_post = exports.hook_data_post;
  this.hook_queue = exports.hook_queue;
};

// data hook: enable parse_body + attachment_hooks to capture PGP/MIME attachments
exports.hook_data = function (next, connection) {
  var plugin = this;
  var txn = connection.transaction;
  if (txn) {
    txn.parse_body = true;
    txn._pgpEncryptedData = null;

    txn.attachment_hooks(function (ct, filename, body, stream) {
      plugin.loginfo('[mg] attachment: ct=' + ct + ' fn=' + filename);
      if (ct && ct.indexOf('application/octet-stream') >= 0) {
        var chunks = [];
        stream.on('data', function (chunk) { chunks.push(chunk); });
        stream.on('end', function () {
          var raw = Buffer.concat(chunks);
          // check ASCII armor first (PGP/MIME may be armored or binary)
          var str = raw.toString('utf-8');
          if (str.indexOf('-----BEGIN PGP MESSAGE-----') >= 0) {
            // ASCII armor -> pass as a string
            txn._pgpEncryptedData = str;
            plugin.loginfo('[mg] PGP ASCII armor: ' + str.length + ' chars');
          } else {
            txn._pgpEncryptedData = raw;
            plugin.loginfo('[mg] PGP binary: ' + raw.length + ' bytes');
          }
        });
      }
    });
  }
  return next();
};

// data_post hook: txn.body has been parsed
exports.hook_data_post = function (next, connection) {
  var plugin = this;

  var sender = getSender(connection);
  if (!sender || sender === '<>') return next(OK);

  var isSubmit = rcptContains(connection, 'submit');
  var isVerify = rcptContains(connection, 'verify');
  if (!isSubmit && !isVerify) return next(OK);

  var subject = getSubject(connection);
  var txn = connection.transaction;

  var body = txn ? getBody(txn) : '';
  // if a PGP/MIME encrypted attachment was captured, use its binary data as the body
  if (txn && txn._pgpEncryptedData && txn._pgpEncryptedData.length > 0) {
    body = txn._pgpEncryptedData;
    plugin.loginfo('[mg] using PGP/MIME binary body: ' + body.length + ' bytes');
  }

  plugin.loginfo(`[mg] sender="${sender}" submit=${isSubmit} verify=${isVerify} subject="${(subject||'').substring(0,30)}" body=${body.length}`);

  // verify@ pipeline: code matching
  if (isVerify) {
    handleVerification(plugin, sender, body);
    return next(OK);
  }

  // submit@ pipeline: submission
  redis.isAuthorized(sender).then(function (isAuth) {
    if (isAuth) { processSubmission(plugin, sender, subject, body).catch(function(e){ plugin.logerror('[mg] processSubmission error: ' + (e.stack || e.message)); }); return; }

    var rl = getRatelimitConfig();
    redis.getSubmissionRateLimit(sender).then(function (count) {
      if (count >= rl.submission.max_attempts) {
        plugin.loginfo('[mg] rate-limited');
        var alertCfg = require('./shared/config').getAlertConfig();
        redis.incrAlertCounter(alertCfg.threshold_window_minutes).then(function (hits) {
          if (hits >= alertCfg.ratelimit_hits_threshold) {
            var mailer = require('./shared/mailer');
            mailer.sendAdminAlert('alert_developer', {
              message: hits + ' rate limit hits in ' + alertCfg.threshold_window_minutes + ' min',
              sender: sender
            }).catch(function (e) { plugin.logerror('[mg] admin alert failed: ' + e.message); });
          }
        }).catch(function (e) { plugin.logerror('[mg] alert counter error: ' + e.message); });
        return;
      }
      redis.incrSubmissionRateLimit(sender, rl.submission.window_seconds).then(function () {
        var auth = getAuthConfig();
        var domain = extractDomain(sender);
        if (isDomainAllowed(domain, auth.allowed_domains, auth.match_mode)) {
          redis.addAuthorized(sender).then(function () {
            redis.clearSubmissionRateLimit(sender);
            processSubmission(plugin, sender, subject, body).catch(function(e){ plugin.logerror('[mg] processSubmission error: ' + (e.stack || e.message)); });
          }).catch(function (e) { plugin.logerror('[mg] addAuthorized error: ' + e.message); });
        } else {
          handleVerifyFlow(plugin, sender);
        }
      }).catch(function (e) { plugin.logerror('[mg] submission rate limit error: ' + e.message); });
    }).catch(function (e) { plugin.logerror('[mg] getSubmissionRateLimit error: ' + e.message); });
  }).catch(function (err) { plugin.logerror(`[mg] ${err.message}`); });

  return next(OK);
};

// PGP decrypt - returns { body, subject, status: 'ok'|'failed'|'not_encrypted' }
async function tryPgpDecrypt(body, subject) {
  // detect PGP: ASCII armor or binary PGP/MIME
  var isAsciiArmor = (typeof body === 'string') && body.indexOf('-----BEGIN PGP MESSAGE-----') >= 0;
  var isBinary = Buffer.isBuffer(body) && body.length > 0;
  if (!isAsciiArmor && !isBinary) return { body: body, subject: subject, status: 'not_encrypted' };

  var pgp = getPgpConfig();
  try {
    if (!fs.existsSync(pgp.private_key_path)) return { body: body, subject: subject, status: 'failed', error: 'Private key not found at ' + pgp.private_key_path };

    var privateKeyArmored = fs.readFileSync(pgp.private_key_path, 'utf-8');
    var privateKey = pgp.passphrase
      ? await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }), passphrase: pgp.passphrase })
      : await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });

    var message;
    if (isBinary) {
      message = await openpgp.readMessage({ binaryMessage: body });
    } else {
      message = await openpgp.readMessage({ armoredMessage: body });
    }
    var decResult = await openpgp.decrypt({ message: message, decryptionKeys: privateKey });
    var decrypted = decResult.data.toString();

    // the decrypted payload is a full MIME message; extract Subject and text/plain
    var headersEnd = decrypted.indexOf('\r\n\r\n');
    if (headersEnd < 0) headersEnd = decrypted.indexOf('\n\n');
    var headerSection = headersEnd > 0 ? decrypted.substring(0, headersEnd) : '';
    var rawBody = headersEnd > 0 ? decrypted.substring(headersEnd + 2).replace(/^\r?\n/, '') : decrypted;

    // extract Subject (parse line by line, handling folded headers)
    var newSubject = subject;
    var hdrLines = headerSection.split(/\r?\n/);
    for (var hi = 0; hi < hdrLines.length; hi++) {
      var line = hdrLines[hi];
      if (line.match(/^Subject:\s*/i)) {
        var subj = line.replace(/^Subject:\s*/i, '');
        // handle folded lines (continuation starts with whitespace)
        while (hi + 1 < hdrLines.length && /^\s/.test(hdrLines[hi + 1])) {
          hi++;
          subj += hdrLines[hi].replace(/^\s+/, '');
        }
        // decode RFC 2047 encoded words (=?charset?encoding?text?=)
        subj = subj.replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, function(m) {
          try {
            var p = m.replace(/^=\?|\?=$/g, '').split('?');
            if (p.length >= 3) {
              if (p[1].toUpperCase() === 'B') return Buffer.from(p[2], 'base64').toString('utf-8');
              if (p[1].toUpperCase() === 'Q') return p[2].replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, function(_,c){return String.fromCharCode(parseInt(c,16));});
            }
          } catch(e) {}
          return m;
        });
        newSubject = subj.trim();
        break;
      }
    }

    // for multipart, try to extract the text/plain part
    var contentType = '';
    var cm = headerSection.match(/^Content-Type:\s*(.+)$/im);
    if (cm) contentType = cm[1];

    var bodyText = rawBody;
    if (contentType && contentType.indexOf('multipart') >= 0) {
      // find the boundary
      var bm = contentType.match(/boundary="(.+?)"/);
      if (bm) {
        var boundary = bm[1];
        var parts = rawBody.split('--' + boundary);
        for (var p = 0; p < parts.length; p++) {
          if (parts[p].indexOf('text/plain') >= 0) {
            var partHeadersEnd = parts[p].indexOf('\r\n\r\n');
            if (partHeadersEnd < 0) partHeadersEnd = parts[p].indexOf('\n\n');
            if (partHeadersEnd > 0) {
              bodyText = parts[p].substring(partHeadersEnd).replace(/^\r?\n\r?\n?/, '').trim();
              break;
            }
          }
        }
      }
    }

    return { body: bodyText, subject: newSubject, status: 'ok' };
  } catch (e) {
    var errDetail = e.message;
    if (e.stack) errDetail += ' | stack: ' + e.stack.split('\n').slice(0,3).join('; ');
    return { body: body, subject: subject, status: 'failed', error: errDetail };
  }
}

async function processSubmission(plugin, sender, subject, body) {
  subject = subject || '(no subject)';

  // Step 3: PGP decrypt
  var pgpResult = await tryPgpDecrypt(body, subject);
  body = pgpResult.body;
  subject = pgpResult.subject;
  plugin.loginfo(`[mg] pgp=${pgpResult.status}`);

  if (pgpResult.status === 'failed') {
    var pgpAttachments = [];
    var pgpCfg = getPgpConfig();
    var pubKeyPath = pgpCfg.private_key_path.replace('private', 'public').replace('SECRET', 'public');
    if (fs.existsSync(pubKeyPath)) {
      pgpAttachments.push({ filename: getAddresses().submit + '.asc', path: pubKeyPath, contentType: 'application/pgp-keys' });
    }
    safeReply({}, 'pgp_decrypt_failed', { _sender: sender, error: pgpResult.error }, pgpAttachments);
    return;
  }

  // email submission length limit: 1000 characters
  const MAX_EMAIL_LENGTH = 1000;
  if (body.length > MAX_EMAIL_LENGTH) {
    plugin.loginfo(`[mg] content too long: ${body.length} > ${MAX_EMAIL_LENGTH}`);
    safeReply({}, 'content_too_long', {
      _sender: sender,
      max_length: String(MAX_EMAIL_LENGTH),
      content_length: String(body.length),
    });
    return;
  }

  if (subject.match(/^\/r\s+/i)) {
    var tid = subject.slice(3).trim().split(/\s+/)[0].toLowerCase().replace(/^#/, '');
    if (tid.length !== 4 && tid.length !== 6) { safeReply({}, 'reply_invalid_id', {_sender:sender}); return; }
    if (!isBase34(tid)) { safeReply({}, 'reply_invalid_id', {_sender:sender}); return; }
    validateId(tid).then(function (v) {
      if (!v.valid) { safeReply({}, 'reply_invalid_id', {_sender:sender}); return; }
      doPost(plugin, sender, 'reply', null, v.entry_id, v.floor_id||null, body, pgpResult.status);
    }).catch(function () { safeReply({}, 'reply_invalid_id', {_sender:sender}); });
  } else {
    doPost(plugin, sender, 'new', subject, null, null, body, pgpResult.status);
  }
}

function doPost(plugin, sender, type, title, entryId, replyToFloor, body, pgpStatus) {
  var p = { type:type, content:body, author:sender, received_at:new Date().toISOString() };
  if (type==='new') p.title = title;
  else { p.entry_id=entryId; p.reply_to_floor=replyToFloor; }
  plugin.loginfo(`[mg] POSTing ${type} pgp=${pgpStatus}`);
  submitPost(p).then(function (r) {
    plugin.loginfo(`[mg] POST ok=${r.ok}`);
    if (r.ok) {
      var cfg = getServerConfig();
      var attachments = [];
      var tplVars = {
        _sender:sender, type:type, entry_id:r.data.entry_id||'',
        entry_url: r.data.entry_id ? 'https://'+cfg.hostname+'/#/entry/'+r.data.entry_id : '',
        pgp_encrypted: pgpStatus === 'ok',
      };

      if (pgpStatus === 'not_encrypted') {
        var pgpCfg = getPgpConfig();
        var pubKeyPath = pgpCfg.private_key_path.replace('private', 'public').replace('SECRET', 'public');
        if (fs.existsSync(pubKeyPath)) {
          attachments.push({ filename: getAddresses().submit + '.asc', path: pubKeyPath, contentType: 'application/pgp-keys' });
        }
      }

      safeReply({}, 'submission_success', tplVars, attachments);
    } else {
      safeReply({}, 'submission_failed', {_sender:sender, error:r.data.error||('HTTP '+r.status)});
    }
  }).catch(function (e) { plugin.logerror(`[mg] POST err: ${e.message}`); });
}

function extractCode(body, regexStr) {
  var filtered = body.split('\n').filter(function (l) { return !l.match(/^(\s*>|--\s*$|__)/); }).join('\n');
  var re = new RegExp(regexStr, 'gm');
  var m = filtered.match(re);
  if (!m) return null;
  for (var i = 0; i < m.length; i++) {
    var inner = new RegExp(regexStr).exec(m[i]);
    if (inner && inner[1]) return inner[1];
  }
  return null;
}

// verify@ pipeline
function handleVerification(plugin, verifier, body) {
  var auth = getAuthConfig();
  var vc = getVerificationConfig();

  var code = extractCode(body, vc.code_regex);
  if (!code) {
    plugin.loginfo(`[mg] verify: no code found from ${verifier}`);
    safeReply({}, 'verify_format_error', { _sender: verifier });
    return;
  }

  var domain = extractDomain(verifier);
  if (!isDomainAllowed(domain, auth.allowed_domains, auth.match_mode)) {
    plugin.loginfo(`[mg] verify: domain "${domain}" rejected`);
    safeReply({}, 'verify_domain_rejected', {
      _sender: verifier,
      verifier_domain: domain,
      allowed_domains: auth.allowed_domains.join(', ')
    });
    return;
  }

  plugin.loginfo(`[mg] verify: code="${code}" from ${verifier}`);
  redis.getVerifyCodeSender(code).then(function (sender) {
    if (!sender) {
      safeReply({}, 'verify_code_expired', { _sender: verifier, code: code });
      return;
    }

    redis.addAuthorized(sender);
    redis.delVerifyCode(code);
    redis.delVerifyRateLimit(sender);
    redis.clearSubmissionRateLimit(sender);

    var poster = require('./shared/poster');
    poster.notifyEmailVerified(sender).catch(function (e) { plugin.logerror(`[mg] notify: ${e.message}`); });

    safeReply({}, 'verify_success', { _sender: verifier, sender_email: sender });
    plugin.loginfo(`[mg] verify: ${sender} authorized by ${verifier}`);
  }).catch(function (e) { plugin.logerror('[mg] verify error: ' + e.message); });
}

function handleVerifyFlow(plugin, sender) {
  var auth = getAuthConfig();
  var rl = getRatelimitConfig();
  redis.getVerifyRateLimit(sender).then(function (c) {
    if (c >= rl.verify.max_attempts) { safeReply({}, 'rate_limit', {_sender:sender, wait_minutes:Math.ceil(rl.verify.window_seconds/60)}); return; }
    return redis.incrVerifyRateLimit(sender, rl.verify.window_seconds).then(function () {
      var vc = getVerificationConfig();
      var code = generateCode(vc.code_length);
      return redis.setVerifyCode(code, sender, vc.code_ttl_seconds).then(function () {
        safeReply({}, 'verify_required', {_sender:sender, code:code, verify_address:getAddresses().verify, code_ttl_minutes: String(Math.ceil(vc.code_ttl_seconds / 60)), allowed_domains: auth.allowed_domains.join(', ')});
      });
    });
  }).catch(function (e) { plugin.logerror('[mg] verify flow error: ' + e.message); });
}
