# Notifications

Channels: signed webhooks, Slack, **email (SMTP)**, **WhatsApp Business Cloud API** and **SMS
(HTTPS gateway)**. Alarm notifications go through a durable queue (`NotificationJob`) with
receipts, retries, dead letters, per-channel rate limits and an audit entry for every dispatch.

## Channel configuration

`POST /api/v1/notifications/channels` `{ name, type, targetUrl, configJson, minSeverity }`.
`targetUrl` is the URL (webhook/Slack), comma-separated addresses (email) or comma-separated
E.164 numbers (WhatsApp/SMS). `configJson` is validated per type
(`backend/src/services/notification/channels/channelConfig.ts`):

| Type | Config | Secrets (write-only) |
| --- | --- | --- |
| EMAIL | `smtpHost`, `smtpPort`, `security` (`tls` = implicit TLS, `starttls` = STARTTLS required, `none` = local relay only), `from`, `username`, `rejectUnauthorized` | `password` |
| WHATSAPP | `phoneNumberId`, `templateName` (pre-approved), `languageCode`, `apiVersion` | `accessToken`, `appSecret`, `verifyToken` |
| SMS | `providerUrl` (https), `senderId` | `apiKey` |
| all | `ratePerMinute` (default 10) | |

Secrets are stored AES-256-GCM encrypted with the appliance credential key, returned only as
`<field>Set: true`, and kept when an update omits them. The webhook HMAC secret is never returned.

## Delivery

- **Email:** in-house SMTP client (no dependency: the common Node mail libraries are MIT-0,
  outside the licence allowlist). Credentials are never sent without TLS; STARTTLS cannot be
  downgraded. The receipt is the relay's queue id (`250 ... queued as <id>`); when the relay
  gives none the receipt is empty, never invented.
- **WhatsApp:** one template message per recipient; parameters `{{1}}` severity, `{{2}}` title,
  `{{3}}` camera, `{{4}}` time. The `wamid` is the receipt. Delivery states arrive on
  `GET/POST /api/v1/notifications/whatsapp/webhook/:channelId` (GET echoes `hub.challenge` for the
  channel's `verifyToken`; POST requires a valid `X-Hub-Signature-256` with the channel's
  `appSecret`). Receipts only move forward (`SENT -> DELIVERED -> READ`, or `FAILED`).
- **SMS:** `POST providerUrl` with `Authorization: Bearer <apiKey>` and
  `{ to, message, sender }`; the response's `id`/`messageId` is the receipt. Other gateways
  implement `SmsProvider`.
- **Retries:** 5 s x attempt^2 backoff (max 120 s), `maxAttempts` 3. Permanent failures (4xx
  except 429, rejected recipient, bad credentials, misconfiguration) go straight to
  `DEAD_LETTER`. For WhatsApp/SMS, recipients the provider already accepted are not messaged
  again on retry.
- **Dead letters:** `GET /notifications/dead-letters`, `POST /notifications/jobs/:id/retry`
  (audited), and the Dead Letters tab in the UI.
- **Air-gapped sites:** `VIGILONE_AIR_GAPPED=true` blocks WhatsApp, SMS, Slack and webhooks
  (`AIR_GAPPED_CHANNEL_BLOCKED`, dead letter, no network call). Email to a local relay still works.
- Audit: `NOTIFICATION_DISPATCH` per attempt (outcome, status code, provider ids),
  `NOTIFICATION_CHANNEL_CREATE|UPDATE|DELETE|TEST`, `NOTIFICATION_JOB_RETRY`.
- Metrics: `vigilone_notification_dispatch_total{channel_type,outcome}`,
  `vigilone_notification_receipts_total{channel_type,result}`,
  `vigilone_notification_audit_failures_total`.

## Tests

`smtpClient.test.ts` (in-process SMTP test double with STARTTLS on an openssl certificate;
MailHog interop when `MAILHOG_BIN` is present, required with `VIGILONE_REQUIRE_MAILHOG=1`) and
`notificationDeliveryRealDb.test.ts` (real DB and HTTP; WhatsApp against a local test double
reachable only under `NODE_ENV=test`). Not verified: a real Meta WhatsApp account, a real SMS
gateway, a production SMTP relay.
