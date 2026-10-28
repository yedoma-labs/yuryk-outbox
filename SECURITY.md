# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

Pre-1.0: only the latest published minor receives fixes.

## Security Model

`@yedoma-labs/yuryk-outbox` sends outbound webhooks. It assumes:

- **Secrets** (`whsec_...`) are provisioned by trusted code or configuration and are never logged by the library.
- **Destination URLs** are chosen by the developer. Only `https:` is accepted unless `allowInsecureHttp: true` is set explicitly.
- **Event payloads** are application data and are serialized exactly once. They are sent as-is.
- **Receiver responses** are untrusted. The library reads only the HTTP status and Retry-After header. The response body is never read, parsed, or returned.

## Security Features

1. **Secret protection**
   - Secrets are validated against the Standard Webhooks format (`whsec_<base64>`) and rejected with `MALFORMED_SECRET` without echoing the value.
   - The secret is never included in error messages, dead-letter callback arguments, or results.

2. **Signature integrity**
   - HMAC-SHA256 over `<id>.<timestamp>.<body>`, computed once per event.
   - The same bytes, ID, and signature are reused on every retry.

3. **URL validation**
   - Only `https:` by default. Plain HTTP requires an explicit opt-in.
   - URLs with embedded credentials (`user:pass@host`) are rejected.

4. **Resource limits**
   - Every attempt runs under `AbortSignal.timeout` (default 10 s).
   - Attempts are bounded by `maxAttempts` and a capped backoff (`maxMs`, default 5 min), and Retry-After values are capped to the same limit.

5. **Response handling**
   - The response body is cancelled without being read (zero bytes consumed).

## Known Limitations

- **SSRF**: the library does not block private or link-local addresses. Destination URLs must not be derived from untrusted input.
- **Dead-letter persistence** is the caller's responsibility. Undelivered events are only reported through `onDeadLetter`; if that callback does not persist them, they are lost.
- **Delivery is at-least-once.** Receivers must deduplicate by `webhook-id`.

## Reporting Vulnerabilities

If you discover a security vulnerability in `@yedoma-labs/yuryk-outbox`, please open a GitHub issue. Include a description, reproduction steps, impact, and a suggested fix if you have one. We aim to respond within 48 hours and will coordinate disclosure.

## Dependency Security

The library has **zero runtime dependencies**. Run `npm audit` regularly.

## License

MIT - See [LICENSE](LICENSE) for details.
