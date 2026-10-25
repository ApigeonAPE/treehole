/**
 * test-mail.mjs - offline tests for the mail transport layer and provider chain
 *
 * Usage: node test-mail.mjs
 * No network, Redis or Docker needed; local HTTP stubs emulate Mailgun and Brevo.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const transports = require('./web/src/mail/transports.js');

process.env.MAIL_TEMPLATE_DIR = path.join(ROOT, 'web', 'templates');

// ============================================================
// test infrastructure
// ============================================================

const results = [];
const logs = [];
const logger = {
  log: (m) => logs.push(String(m)),
  warn: (m) => logs.push(String(m)),
  error: (m) => logs.push(String(m)),
};

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL ${name}\n     ${err && err.message}`);
  }
}

function createServer(onRequest) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({ url: req.url, method: req.method, headers: req.headers, raw, text: raw.toString('utf8') });
      onRequest(req, res, raw);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

const mailgun = {
  mode: { status: 200, body: { id: '<mg@test>' }, delay: 0 },
  requests: [],
};
const brevo = {
  mode: { status: 201, body: { messageId: '<brevo@test>' }, delay: 0 },
  requests: [],
};

const mailgunSrv = await createServer((req, res) => {
  const mode = mailgun.mode;
  const send = () => {
    res.statusCode = mode.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(mode.body || {}));
  };
  if (mode.delay) setTimeout(send, mode.delay); else send();
});
const brevoSrv = await createServer((req, res) => {
  const mode = brevo.mode;
  const send = () => {
    res.statusCode = mode.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(mode.body || {}));
  };
  if (mode.delay) setTimeout(send, mode.delay); else send();
});

// share the request logs with the stubs above
function resetStubs() {
  mailgun.mode = { status: 200, body: { id: '<mg@test>' }, delay: 0 };
  brevo.mode = { status: 201, body: { messageId: '<brevo@test>' }, delay: 0 };
  logs.length = 0;
}

function makeStore(initialUsed = {}) {
  const used = { ...initialUsed };
  const down = {};
  return {
    used,
    down,
    async snapshot(names) {
      return {
        used: Object.fromEntries(names.map((n) => [n, used[n] || 0])),
        down: Object.fromEntries(names.map((n) => [n, !!down[n]])),
        degraded: false,
      };
    },
    async reserve(name, cap) {
      const next = (used[name] || 0) + 1;
      if (next > cap) return { ok: false, used: used[name] || 0 };
      used[name] = next;
      return { ok: true, used: next };
    },
    async release(name) {
      if ((used[name] || 0) > 0) used[name] -= 1;
    },
    async markDown(name) { down[name] = true; },
    async clearDown(name) { delete down[name]; },
  };
}

function makeCfg(overrides = {}) {
  const {
    order = ['mailgun', 'brevo'],
    strategy = 'balanced',
    caps = { mailgun: 100, brevo: 300 },
    reserve = 0,
    quota = true,
    timeout = 2000,
    attachmentFallback = 'rename',
  } = overrides;

  return {
    chain: order,
    strategy,
    timeoutMs: timeout,
    quota: { enabled: quota, resetTimezone: 'UTC', reserveForCritical: reserve, caps },
    health: { cooldownSeconds: 60 },
    providers: {
      mailgun: {
        enabled: true,
        apiKey: 'mg-key-SECRET',
        domain: 'mail.test',
        apiUrl: `http://127.0.0.1:${mailgunSrv.port}/v3`,
      },
      brevo: {
        enabled: true,
        apiKey: 'brevo-stub-key',
        apiUrl: `http://127.0.0.1:${brevoSrv.port}/v3/smtp/email`,
        tags: ['treehole'],
        attachmentFallback,
      },
      smtp: { enabled: true, host: 'smtp.test', port: 25, secure: false, auth: null },
    },
  };
}

function makeMsg(overrides = {}) {
  return {
    from: { name: 'Treehole', email: 'noreply@mail.treehole.example' },
    to: 'user@example.com',
    subject: 'Test subject',
    text: 'Body text',
    replyTo: null,
    attachments: [],
    priority: 'normal',
    ...overrides,
  };
}

const smtpStub = () => Promise.resolve({ id: '<smtp@test>' });
const call = (msg, cfg, store, smtpSend = smtpStub) =>
  transports.sendWithFallback(msg, cfg, { store, smtpSend, log: logger });

// ============================================================
// 1. request construction
// ============================================================

await test('Mailgun: URL / Basic auth / form fields / Reply-To', async () => {
  resetStubs();
  const before = mailgunSrv.requests.length;
  const cfg = makeCfg({ order: ['mailgun'], quota: false });
  const res = await call(makeMsg({ replyTo: { email: 'submit@mail.treehole.example' } }), cfg, null);

  assert.equal(res.provider, 'mailgun');
  assert.equal(res.id, '<mg@test>');
  const req = mailgunSrv.requests[before];
  assert.equal(req.url, '/v3/mail.test/messages');
  assert.equal(req.method, 'POST');
  assert.equal(
    req.headers.authorization,
    'Basic ' + Buffer.from('api:mg-key-SECRET').toString('base64'),
  );
  assert.match(String(req.headers['content-type']), /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(req.text);
  assert.equal(form.get('from'), 'Treehole <noreply@mail.treehole.example>');
  assert.equal(form.get('to'), 'user@example.com');
  assert.equal(form.get('subject'), 'Test subject');
  assert.equal(form.get('text'), 'Body text');
  assert.equal(form.get('h:Reply-To'), 'submit@mail.treehole.example');
});

await test('Mailgun: attachments use multipart', async () => {
  resetStubs();
  const before = mailgunSrv.requests.length;
  const cfg = makeCfg({ order: ['mailgun'], quota: false });
  await call(makeMsg({
    attachments: [{ filename: 'submit@mail.treehole.example.asc', contentType: 'application/pgp-keys', content: Buffer.from('PGPKEY') }],
  }), cfg, null);
  const req = mailgunSrv.requests[before];
  assert.match(String(req.headers['content-type']), /multipart\/form-data; boundary=/);
  assert.match(req.text, /filename="submit@mail\.treehole\.example\.asc"/);
  assert.match(req.text, /PGPKEY/);
});

await test('Brevo：api-key / sender / to / textContent / htmlContent / replyTo / tags', async () => {
  resetStubs();
  const before = brevoSrv.requests.length;
  const cfg = makeCfg({ order: ['brevo'], quota: false });
  const res = await call(makeMsg({
    text: 'a & b <c>\nhttps://treehole.example/#/entry/ab12',
    replyTo: { email: 'submit@mail.treehole.example' },
  }), cfg, null);

  assert.equal(res.provider, 'brevo');
  const req = brevoSrv.requests[before];
  assert.equal(req.headers['api-key'], 'brevo-stub-key');
  assert.equal(req.url, '/v3/smtp/email');
  const body = JSON.parse(req.text);
  assert.deepEqual(body.sender, { name: 'Treehole', email: 'noreply@mail.treehole.example' });
  assert.deepEqual(body.to, [{ email: 'user@example.com' }]);
  assert.equal(body.subject, 'Test subject');
  assert.match(body.textContent, /a & b <c>/);
  assert.match(body.htmlContent, /a &amp; b &lt;c&gt;/);
  assert.match(body.htmlContent, /<a href="https:\/\/treehole\.example/);
  assert.deepEqual(body.replyTo, { email: 'submit@mail.treehole.example' });
  assert.deepEqual(body.tags, ['treehole']);
});

await test('Brevo: base64 attachment and .asc rename', async () => {
  resetStubs();
  const before = brevoSrv.requests.length;
  const cfg = makeCfg({ order: ['brevo'], quota: false });
  await call(makeMsg({
    attachments: [{ filename: 'submit@mail.treehole.example.asc', contentType: 'application/pgp-keys', content: Buffer.from('PGPKEY') }],
  }), cfg, null);
  const body = JSON.parse(brevoSrv.requests[before].text);
  assert.equal(body.attachment[0].name, 'submit@mail.treehole.example.asc.txt');
  assert.equal(Buffer.from(body.attachment[0].content, 'base64').toString('utf8'), 'PGPKEY');
});

await test('Brevo: attachment_fallback=skip skips the provider', async () => {
  resetStubs();
  const cfg = makeCfg({ order: ['brevo', 'smtp'], quota: false, attachmentFallback: 'skip' });
  const res = await call(makeMsg({
    attachments: [{ filename: 'key.asc', contentType: 'application/pgp-keys', content: Buffer.from('K') }],
  }), cfg, null);
  assert.equal(res.provider, 'smtp');
  assert.ok(res.attempts.some((a) => a.provider === 'brevo' && a.reason === 'skipped'));
});

// ============================================================
// 2. split and quota
// ============================================================

await test('ratio: caps 100/300 give 2/6 over 8 sends and 8/24 over 32', async () => {
  resetStubs();
  const cfg = makeCfg();
  const store = makeStore();
  for (let i = 0; i < 8; i++) await call(makeMsg(), cfg, store);
  assert.equal(store.used.mailgun, 2);
  assert.equal(store.used.brevo, 6);

  for (let i = 0; i < 24; i++) await call(makeMsg(), cfg, store);
  assert.equal(store.used.mailgun, 8);
  assert.equal(store.used.brevo, 24);
});

await test('hard quota: a full provider is skipped; both full gives quota_exhausted', async () => {
  resetStubs();
  const cfg = makeCfg({ caps: { mailgun: 2, brevo: 2 } });
  const store = makeStore();
  for (let i = 0; i < 4; i++) await call(makeMsg(), cfg, store);
  assert.equal(store.used.mailgun, 2);
  assert.equal(store.used.brevo, 2);

  await assert.rejects(() => call(makeMsg(), cfg, store), (err) => {
    assert.equal(err.name, 'MailError');
    assert.equal(err.reason, 'quota_exhausted');
    return true;
  });
});

await test('reserve: normal uses 85%, critical can use the rest', async () => {
  resetStubs();
  const cfg = makeCfg({ caps: { mailgun: 10, brevo: 10 }, reserve: 0.5 });
  const store = makeStore();
  for (let i = 0; i < 10; i++) await call(makeMsg({ priority: 'normal' }), cfg, store);
  await assert.rejects(() => call(makeMsg({ priority: 'normal' }), cfg, store), /quota_exhausted/);

  await call(makeMsg({ priority: 'critical' }), cfg, store);
  assert.equal(store.used.mailgun + store.used.brevo, 11);
});

await test('concurrency: only one of two requests wins the last slot', async () => {
  const store = makeStore({ mailgun: 1 });
  const [a, b] = await Promise.all([
    store.reserve('mailgun', 2, '2026-01-01'),
    store.reserve('mailgun', 2, '2026-01-01'),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal(store.used.mailgun, 2);
});

// ============================================================
// 3. failure handling
// ============================================================

await test('5xx: fail over and keep the Mailgun quota reservation', async () => {
  resetStubs();
  mailgun.mode = { status: 500, body: { message: 'boom' }, delay: 0 };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'] });
  const store = makeStore();
  const res = await call(makeMsg(), cfg, store);
  assert.equal(res.provider, 'brevo');
  assert.equal(res.attempts.length, 2);
  assert.equal(store.used.mailgun, 1, '5xx must not roll back the quota');
});

await test('4xx: roll back the quota, then fail over', async () => {
  resetStubs();
  mailgun.mode = { status: 400, body: { message: 'bad request' }, delay: 0 };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'] });
  const store = makeStore();
  const res = await call(makeMsg(), cfg, store);
  assert.equal(res.provider, 'brevo');
  assert.equal(store.used.mailgun, 0, '4xx must roll back the quota');
});

await test('timeout: fail over quickly and keep the reservation', async () => {
  resetStubs();
  mailgun.mode = { status: 200, body: { id: 'late' }, delay: 3000 };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'], timeout: 1000 });
  const store = makeStore();
  const started = Date.now();
  const res = await call(makeMsg(), cfg, store);
  const elapsed = Date.now() - started;
  assert.equal(res.provider, 'brevo');
  assert.ok(elapsed < 2500, `took ${elapsed}ms`);
  assert.equal(store.used.mailgun, 1);
});

await test('health cooldown: a failed provider is not retried during cooldown', async () => {
  resetStubs();
  mailgun.mode = { status: 500, body: {}, delay: 0 };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'] });
  const store = makeStore();
  await call(makeMsg(), cfg, store);
  assert.equal(store.down.mailgun, true);

  const beforeMg = mailgunSrv.requests.length;
  const res = await call(makeMsg(), cfg, store);
  assert.equal(res.provider, 'brevo');
  assert.equal(mailgunSrv.requests.length, beforeMg, 'Mailgun must not be called during cooldown');
});

await test('Redis failure: fail-open still sends and warns', async () => {
  resetStubs();
  const broken = {
    async snapshot() { throw new Error('redis down'); },
    async reserve() { throw new Error('redis down'); },
    async release() {},
    async markDown() {},
    async clearDown() {},
  };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'] });
  const res = await call(makeMsg(), cfg, broken);
  assert.equal(res.provider, 'mailgun');
  assert.ok(logs.some((l) => /quota_store_unavailable/.test(l)), 'expected a fail-open warning');
});

await test('all providers fail: MailError summarises every attempt', async () => {
  resetStubs();
  mailgun.mode = { status: 500, body: {}, delay: 0 };
  brevo.mode = { status: 500, body: {}, delay: 0 };
  const cfg = makeCfg({ order: ['mailgun', 'brevo'] });
  const store = makeStore();
  await assert.rejects(() => call(makeMsg(), cfg, store), (err) => {
    assert.equal(err.name, 'MailError');
    assert.equal(err.reason, 'all_failed');
    assert.equal(err.attempts.length, 2);
    return true;
  });
});

// ============================================================
// 4. config resolution (real config.js, with fs stubbed)
// ============================================================

function getMailConfigWith(obj) {
  const configPath = path.join(ROOT, 'web', 'src', 'config.js');
  delete require.cache[require.resolve(configPath)];
  const origRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).replace(/\\/g, '/').endsWith('config.json')) return JSON.stringify(obj);
    return origRead.call(fs, file, ...rest);
  };
  try {
    return require(configPath).getMailConfig();
  } finally {
    fs.readFileSync = origRead;
    delete require.cache[require.resolve(configPath)];
  }
}

const baseCfg = {
  server: { name: 'Treehole', hostname: 'treehole.example', timezone: '+8' },
  addresses: { noreply: 'noreply@mail.treehole.example' },
  smtp: { host: 'opensmtpd', port: 10025 },
  mailgun: { enabled: true, api_key: 'mg', domain: 'mail.treehole.example' },
  jwt: { secret: 'test-secret', expires_in_seconds: 3600 },
};

await test('compatibility: no mail section -> single Mailgun, failover, quota off', () => {
  const cfg = getMailConfigWith(baseCfg);
  assert.deepEqual(cfg.chain, ['mailgun']);
  assert.equal(cfg.strategy, 'failover');
  assert.equal(cfg.quota.enabled, false);
});

await test('compatibility: no mail section and no Mailgun key -> smtp', () => {
  const cfg = getMailConfigWith({ ...baseCfg, mailgun: { enabled: true, api_key: '' } });
  assert.deepEqual(cfg.chain, ['smtp']);
});

await test('mail.order: unconfigured providers are filtered; none usable is an error', () => {
  const cfg = getMailConfigWith({
    ...baseCfg,
    mail: { order: ['mailgun', 'brevo'], strategy: 'balanced', brevo: { enabled: true, api_key: '' } },
  });
  assert.deepEqual(cfg.chain, ['mailgun']);

  assert.throws(() => getMailConfigWith({
    ...baseCfg,
    mailgun: { enabled: true, api_key: '' },
    mail: { order: ['mailgun', 'brevo'], brevo: { enabled: true, api_key: '' } },
  }), /no usable provider/);
});

await test('quota enabled without caps is an error', () => {
  assert.throws(() => getMailConfigWith({
    ...baseCfg,
    mail: {
      order: ['mailgun'], strategy: 'balanced',
      quota: { enabled: true, caps: {} },
      brevo: { enabled: true, api_key: '' },
    },
  }), /caps\.mailgun/);
});

// ============================================================
// 5. web mailer integration (From / template / critical)
// ============================================================

async function withWebMailer(cfg, usedValue, fn) {
  const configPath = path.join(ROOT, 'web', 'src', 'config.js');
  const mailerPath = path.join(ROOT, 'web', 'src', 'mail', 'mailer.js');
  const redisPath = require.resolve(path.join(ROOT, 'web', 'node_modules', 'ioredis'));
  const saved = {
    config: require.cache[configPath],
    mailer: require.cache[mailerPath],
    redis: require.cache[redisPath],
  };

  class FakeRedis {
    on() {}
    async mget(...keys) { return keys.map((k) => (String(k).startsWith('mail:used:') ? String(usedValue) : null)); }
    async incr() { return 1; }
    async expire() { return 1; }
    async decr() { return 0; }
    async get() { return '0'; }
    async set() { return 'OK'; }
    async del() { return 1; }
  }

  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: FakeRedis };
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      getMailConfig: () => cfg,
      getSmtpConfig: () => ({ host: '127.0.0.1', port: 1, secure: false }),
      getAddresses: () => ({
        submit: 'submit@mail.treehole.example',
        verify: 'verify@mail.treehole.example',
        noreply: 'noreply@mail.treehole.example',
        admin_alert: 'admin@example.com',
        postmaster: 'postmaster@mail.treehole.example',
      }),
      getServerConfig: () => ({ name: 'Treehole', hostname: 'treehole.example' }),
    },
  };
  delete require.cache[mailerPath];

  try {
    const mailer = require(mailerPath);
    return await fn(mailer);
  } finally {
    delete require.cache[mailerPath];
    if (saved.config) require.cache[configPath] = saved.config; else delete require.cache[configPath];
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
  }
}

await test('web mailer: OTP from noreply, code in subject, priority=critical', async () => {
  resetStubs();
  const before = brevoSrv.requests.length;
  const cfg = makeCfg({ order: ['brevo'], quota: true, caps: { mailgun: 0, brevo: 10 }, reserve: 0.5 });

  // usedValue=6, cap=10, reserve=0.5 -> normal is blocked by the reserve; only critical goes out
  await withWebMailer(cfg, 6, async (mailer) => {
    const res = await mailer.sendLoginOtp('student@example.com', '654321');
    assert.equal(res.provider, 'brevo');
  });

  const body = JSON.parse(brevoSrv.requests[before].text);
  assert.deepEqual(body.sender, { name: 'Treehole', email: 'noreply@mail.treehole.example' });
  assert.match(body.subject, /654321/);
  assert.match(body.textContent, /654321/);
});

// ============================================================
// 6. safety and teardown
// ============================================================

await test('no secrets appear in the logs', async () => {
  const joined = logs.join('\n');
  assert.ok(!joined.includes('mg-key-SECRET'), 'Mailgun key leaked');
  assert.ok(!joined.includes('brevo-stub-key'), 'Brevo key leaked');
});

mailgunSrv.server.close();
brevoSrv.server.close();

const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`passed ${results.length - failed.length}, failed ${failed.length}`);
if (failed.length) {
  console.log('\nFailures:');
  failed.forEach((r) => console.log(` - ${r.name}: ${r.err && r.err.message}`));
}
process.exit(failed.length ? 1 : 0);
