# @yedoma-labs/yuryk-outbox

<picture>
  <source media="(max-width: 640px)" srcset="https://raw.githubusercontent.com/yedoma-labs/assets/main/resized/banner-resized-mobile.png">
  <img src="https://raw.githubusercontent.com/yedoma-labs/assets/main/resized/banner-resized.png" alt="Project Header">
</picture>

[![CI](https://github.com/yedoma-labs/yuryk-outbox/actions/workflows/ci.yml/badge.svg)](https://github.com/yedoma-labs/yuryk-outbox/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@yedoma-labs/yuryk-outbox.svg)](https://www.npmjs.com/package/@yedoma-labs/yuryk-outbox)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **юрык** (*yuryk*) — Yakutian (Sakha) for "(noch zu bestätigen)"

Lightweight outbound webhook sender with correct retry semantics. Stable event IDs across retries, `Retry-After` support, per-attempt timeouts, and [Standard Webhooks](https://www.standardwebhooks.com/) signatures. Zero runtime dependencies, Node 20+.

Counterpart to `@yedoma-labs/tuyar-webhook`, which verifies incoming webhooks.

```
pnpm add @yedoma-labs/yuryk-outbox
```

---

## The problem

Hand-rolled webhook senders tend to get the same things wrong:

- **Duplicates on retry.** A new event ID per attempt makes receivers treat each retry as a new event.
- **Signatures recomputed per attempt.** The timestamp changes, so the signature changes, and the body may be serialized differently each time.
- **`Retry-After` ignored.** Receivers that ask for a pause get hammered anyway.
- **No timeout.** A hanging receiver blocks the sender indefinitely.
- **Retries on permanent errors.** A `400` or `404` will not succeed on the fifth try.

`yuryk-outbox` handles these. It is a sender only: it does not store events, run queues, or provide a dashboard.

## Quickstart

```ts
import { createWebhookSender } from "@yedoma-labs/yuryk-outbox";

const sender = createWebhookSender({
	secret: process.env.WEBHOOK_SECRET!, // whsec_<base64>
	onDeadLetter: async ({ url, id, attempts, lastStatus, lastError }) => {
		await db.insert("failed_webhooks", { url, id, attempts, lastStatus, error: lastError?.message });
	},
});

const result = await sender.send("https://customer.example.com/hooks", {
	type: "invoice.paid",
	id: "evt_01J9Z3",
	data: { invoiceId: "inv_123", amount: 4200 },
});

if (!result.ok) {
	// already dead-lettered; result.attempts and result.status describe the failure
}
```

The receiver gets:

```
POST /hooks
content-type: application/json
webhook-id: evt_01J9Z3
webhook-timestamp: 1800000000
webhook-signature: v1,<base64 HMAC-SHA256>

{"type":"invoice.paid","timestamp":"2027-01-15T08:00:00.000Z","data":{"invoiceId":"inv_123","amount":4200}}
```

If `id` is omitted, a `msg_<uuid>` ID is generated once per event and reused on every retry.

## Retry behavior

| Response or failure                                       | Action                                                  |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `2xx`                                                     | Success, stop.                                          |
| Network error, timeout (`timeoutMs`)                      | Retry.                                                  |
| `408`, `425`, `429`, `5xx`                                | Retry.                                                  |
| Other `4xx`                                               | Fail immediately, no retry.                             |
| `1xx`, `3xx` (redirects are not followed)                 | Fail immediately, no retry.                             |

Delays between attempts:

- If the response has `Retry-After` (seconds or HTTP-date), that delay is used, capped to `backoff.maxMs`.
- Otherwise full jitter: `random() * min(maxMs, baseMs * 2^(attempt - 1))`.
- No sleep after the final attempt.

After the last failed attempt, `onDeadLetter` is called once and `send()` resolves with `{ ok: false, attempts, status? }`. This also applies to non-retryable failures.

## Options

| Option                 | Default      | Description                                                                 |
| ---------------------- | ------------ | --------------------------------------------------------------------------- |
| `secret`               | required     | `whsec_<base64>`. Invalid values throw `MALFORMED_SECRET` at creation.      |
| `fetch`                | global       | Injectable fetch implementation.                                            |
| `timeoutMs`            | `10000`      | Timeout per attempt.                                                        |
| `maxAttempts`          | `5`          | Total attempts, including the first.                                        |
| `backoff.baseMs`       | `1000`       | Base delay for exponential backoff.                                         |
| `backoff.maxMs`        | `300000`     | Cap for any single delay, including `Retry-After`.                          |
| `allowInsecureHttp`    | `false`      | Allow `http:` URLs. For local development only.                             |
| `random`               | `Math.random`| Source for jitter, returns a value in `[0, 1)`.                             |
| `now`                  | `Date.now`   | Clock in epoch milliseconds.                                                |
| `sleep`                | `setTimeout` | Waiting function between attempts.                                          |
| `onDeadLetter`         | none         | Called once when delivery has failed for good.                              |

## Signing and timestamps

- The signature is HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>`, using the base64-decoded secret as key.
- The body is serialized once. The ID, timestamp, body, and signature are fixed before the first attempt and sent unchanged on every retry.
- `webhook-timestamp` is the event time in seconds (`event.timestamp`, or the clock at the first attempt). It does not move with retries.

**Receiver tolerance.** Standard Webhooks receivers commonly accept timestamps within 5 minutes. With the defaults, all retries happen within about 55 seconds of the first attempt in the worst case (4 timeouts of 10 s plus 1 + 2 + 4 + 8 s of backoff at most), so they stay well inside that window. `Retry-After` can extend the window: each delay can be up to `backoff.maxMs`. If your receivers enforce a 5-minute tolerance and your upstream sends large `Retry-After` values, lower `backoff.maxMs` or `maxAttempts` so that the total stays below the receiver's limit.

## Idempotency on the receiver

Delivery is **at-least-once**. A receiver can get the same event again if its response was lost, or if the sender timed out after the receiver had already processed the request. Deduplicate by `webhook-id` on the receiver side and treat repeated IDs as no-ops.

## Dead letters

`onDeadLetter` receives `{ url, event, id, attempts, lastStatus?, lastError? }`. Persisting failed deliveries is the caller's job. If the callback does not persist them, they are lost. Errors thrown by the callback reject `send()` with `WebhookSenderError` and code `DEAD_LETTER_CALLBACK_FAILED`, so they are never silently dropped.

## Errors

All configuration and input errors throw `WebhookSenderError` with a `code`:

| Code                          | When                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `MALFORMED_SECRET`            | Secret is not `whsec_<base64>` (thrown by `createWebhookSender`). |
| `INVALID_URL`                 | Not absolute, not `https:` (unless `allowInsecureHttp`), or contains credentials. |
| `INVALID_EVENT`               | Empty `type`, empty `id`, invalid `timestamp`, or `data` that `JSON.stringify` cannot serialize (circular references, `BigInt`). |
| `INVALID_OPTIONS`             | Out-of-range `timeoutMs`, `maxAttempts`, or `backoff` values. |
| `DEAD_LETTER_CALLBACK_FAILED` | `onDeadLetter` threw or rejected. The original error is in `cause`. |

Messages never include the secret. The receiver's response body is never read, parsed, or returned. Only the status is.

## Comparison

- **[svix](https://www.svix.com/)** is a full webhook platform: hosted or self-hosted service, endpoint management, dashboards, and a message store. Choose it if you want to outsource webhook delivery as a product.
- **`yuryk-outbox`** is a small library for your own process. It sends, signs, and retries once, and hands failures to your code. Choose it if you want correct semantics without running another service.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
