# Treehole — Email-Authenticated Message Board

An anonymous message board where posts can be submitted by email. Inbound mail is
authenticated against a trusted email domain, optionally decrypted with PGP, and
stored as threads with threaded replies. A React SPA provides reading, posting and
account management on top of a small Express API.

```
                         Internet
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    :25 SMTP            :80 HTTP            :443 HTTPS
   [Haraka]            [Caddy] ─────────── [Caddy]
        │                   │
        │                 :80 [Web]
        │                   │
        ├── Redis ──────────┤
        │                   │
   :10025 [OpenSMTPD]       │
        │                   ▼
        ▼              SQLite + static files
   outbound delivery
```

| Container | Responsibility |
|---|---|
| **Haraka** | Inbound SMTP; receives submissions and verification mail; PGP decryption |
| **Web** | Express API + React SPA; email delivery (Mailgun / Brevo / SMTP) |
| **Caddy** | HTTPS reverse proxy with automatic certificates |
| **OpenSMTPD** | Outbound relay with DKIM signing (optional; not used when Mailgun/Brevo is enabled) |
| **Redis** | Authorized emails, OTPs, rate-limit counters |

---

## Quick start

```bash
git clone <your-repo> /opt/treehole && cd /opt/treehole

# 1. Generate shared secrets
openssl rand -hex 32   # internal_token
openssl rand -hex 32   # webhook_token
openssl rand -hex 32   # admin token

# 2. Edit config.json
#    - addresses.*            real mailboxes
#    - server.hostname        public site hostname
#    - auth.allowed_domains   trusted domains
#    - internal_token / webhook_token / admin.token
#    - jwt.secret             leave empty to auto-generate
#    - mailgun / mail.brevo   provider credentials
#
#    No mail provider? Set mail.order to ["smtp"] and
#    mail.quota.enabled to false to deliver through the local relay.

# 3. Accepted recipient domains
vim haraka/config/host_list

# 4. Public hostname
vim Caddyfile

# 5. DKIM domain (only for the OpenSMTPD path)
vim opensmtpd/smtpd.conf

# 6. Keys
mkdir -p data/dkim haraka/pgp
cp /path/to/dkim_private.key data/dkim/mail.private
cp /path/to/private.asc haraka/pgp/private.asc
cp /path/to/public.asc  haraka/pgp/public.asc

# 7. Frontend build
cd web/frontend && npm ci && npm run build && cd ../..

# 8. Start
docker compose up -d --build
```

## Local development

```bash
# Full stack with Mailpit instead of OpenSMTPD
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

# Frontend rebuilds are picked up immediately (public/ is bind-mounted)
cd web/frontend && npm run build

# Web:     http://localhost:8080
# Mailpit: http://localhost:8025
# SMTP:    localhost:2525
```

---

## Configuration

`config.json` is the single source of truth. `config.local.json` (when present)
is deep-merged over it and is used for local development.

### Server

| Field | Purpose | Notes |
|---|---|---|
| `server.name` | Display name used in emails | |
| `server.site_title` | Browser title | |
| `server.hostname` | Public hostname used in reply links | |
| `server.timezone` | Timezone offset for email timestamps | `+8` |
| `server.verify_instructions` | Verification instructions template | supports `{verify_address}`, `{trusted_domains}` |

### Addresses

`submit@…`, `verify@…`, `noreply@…`, `admin_alert@…`, `postmaster@…`.

### Mail delivery (`mail`)

| Field | Purpose |
|---|---|
| `mail.strategy` | `balanced` (quota-aware split) or `failover` (strict order) |
| `mail.order` | Provider candidates, e.g. `["mailgun", "brevo"]` |
| `mail.timeout_ms` | Per-attempt timeout |
| `mail.quota.caps` | Daily caps per provider |
| `mail.quota.reserve_for_critical` | Share reserved for login/verification mail |
| `mail.brevo.api_key` | Brevo API key (production only) |

Emails are delivered through the first provider that accepts them. Daily usage is
tracked in Redis (`mail:used:<provider>:<date>`), so the split adapts to each
provider's cap. `./admin.sh --mail-stats` shows current usage.

### Authentication

| Field | Purpose |
|---|---|
| `jwt.secret` | Signing key; empty means a random key is generated at boot |
| `jwt.expires_in_seconds` | Token lifetime |
| `auth.allowed_domains` | Domains auto-trusted for submission |
| `auth.match_mode` | `suffix` or `exact` |

### Rate limits

`ratelimit.submission`, `ratelimit.cooldown_seconds`, `ratelimit.verify`.

### Verification

`verification.code_length`, `verification.code_ttl_seconds`, `verification.code_regex`.

### Other

`pgp.*` (private key path and passphrase), `target.*` (internal webhook),
`alert.*` (abuse alerting), `dkim.*`, `smtp.*` (fallback relay).

---

## Email templates

Templates use Mustache. The first line, if it starts with `## `, becomes the subject.

Haraka (`haraka/config/templates/`):

| Template | When |
|---|---|
| `submission_success` | Submission or reply stored |
| `submission_failed` | Internal API rejected the submission |
| `pgp_decrypt_failed` | PGP decryption failed (public key attached) |
| `content_too_long` | Body above the email limit |
| `reply_invalid_id` | `/r <id>` target is invalid |
| `verify_required` | Unverified sender, code issued |
| `verify_success` | Verification completed |
| `verify_format_error` | No code found in the verification email |
| `verify_code_expired` | Code unknown or expired |
| `verify_domain_rejected` | Verification sender domain not trusted |
| `rate_limit` | Verification rate limit hit |
| `alert_developer` | Admin alert |

Web (`web/templates/`): `login_otp`, `bind_email_code`.

Available variables: `{{server_name}}`, `{{code}}`, `{{submit_address}}`,
`{{verify_address}}`, `{{timestamp}}`.

---

## Admin CLI

```bash
./admin.sh --whois <ID>        # author of a thread or floor
./admin.sh --history <UID>     # all posts and replies by a user
./admin.sh --hide <ID>         # hide a thread or floor
./admin.sh --unhide <ID>       # unhide
./admin.sh --del <ID>          # delete a thread or floor
./admin.sh --ban <UID> [days]  # ban a user (omit days for permanent)
./admin.sh --unban <UID>       # unban
./admin.sh --mail-stats        # per-provider email usage for today
```

## Data

| Store | Location | Contents |
|---|---|---|
| SQLite | `web/data/treehole.db` | users, emails, threads, replies, favorites, bans |
| Redis | container volume | authorized emails, OTPs, rate limits |

## Limits

| Channel | Max body length |
|---|---|
| Web | 200 characters |
| Email | 1000 characters |

Threads hold at most 1155 floors (`zz` in base-34).

## PGP

Place keys in `haraka/pgp/`. Encrypted mail is decrypted automatically; submissions
without encryption receive the public key in the reply. Rotation: add
`0 3 1 * * cd /opt/treehole && bash rotate-pgp.sh` to `crontab -e`.

## Outbound providers

Two HTTP providers are supported out of the box: Mailgun and Brevo. Both are
configured under `mail` / `mailgun`. A plain SMTP relay (`smtp.*`) can be used as a
third candidate or for local development.

When `mail.strategy` is `balanced`, each message goes to the provider with the
largest remaining share of its own daily cap; login and verification mail keep a
reserved share so they are never starved by bulk receipts.

---

## Layout

```
.
├── Caddyfile                 reverse proxy
├── config.json / config.local.json
├── docker-compose.yml / .local.yml
├── admin.sh                  admin CLI
├── rotate-pgp.sh             monthly PGP rotation
├── haraka/                   inbound SMTP gateway
│   ├── config/               Haraka config, host list, templates
│   └── plugins/              mail_gateway + shared helpers
├── web/                      Express API + SPA
│   ├── src/                  API, DB, auth, mail transports
│   ├── frontend/             React source
│   ├── templates/            login/bind email templates
│   └── public/               built SPA assets
├── opensmtpd/                outbound relay (optional)
└── redis/, caddy/, data/     runtime volumes
```

## License

Add the license of your choice before publishing.
