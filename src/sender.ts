import { randomUUID } from "node:crypto";
import { WebhookSenderError } from "./errors";
import { backoffDelay, isRetryableStatus, isSuccessStatus, parseRetryAfter } from "./retry";
import { decodeSecret } from "./secret";
import { signPayload } from "./signature";
import type {
	DeadLetter,
	DeliveryResult,
	WebhookEvent,
	WebhookSender,
	WebhookSenderOptions,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 300_000;

/**
 * Creates a sender for Standard Webhooks signed deliveries with retries.
 *
 * Per event, the body is serialized once, the ID and the timestamp are fixed, and the signature is
 * computed once. Every attempt sends the same bytes and the same headers.
 */
export function createWebhookSender(options: WebhookSenderOptions): WebhookSender {
	const key = decodeSecret(options.secret);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const baseMs = options.backoff?.baseMs ?? DEFAULT_BASE_MS;
	const maxMs = options.backoff?.maxMs ?? DEFAULT_MAX_MS;
	const allowInsecureHttp = options.allowInsecureHttp ?? false;
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const onDeadLetter = options.onDeadLetter;

	assertOptions({ timeoutMs, maxAttempts, baseMs, maxMs });

	return {
		async send(url: string, event: WebhookEvent): Promise<DeliveryResult> {
			assertTargetUrl(url, allowInsecureHttp);
			assertEvent(event);

			const id = event.id ?? `msg_${randomUUID()}`;
			const timestampMs = event.timestamp ? event.timestamp.getTime() : now();
			if (!Number.isFinite(timestampMs)) {
				throw new WebhookSenderError("INVALID_EVENT", "event timestamp is not a valid date");
			}
			const timestamp = Math.floor(timestampMs / 1000);

			// Serialized exactly once. Retries reuse these bytes, so the signature stays valid.
			const body = JSON.stringify({
				type: event.type,
				timestamp: new Date(timestamp * 1000).toISOString(),
				data: event.data,
			});
			const headers = {
				"content-type": "application/json",
				"webhook-id": id,
				"webhook-timestamp": String(timestamp),
				"webhook-signature": signPayload(key, id, timestamp, body),
			};

			let attempts = 0;
			let lastStatus: number | undefined;
			let lastError: Error | undefined;

			while (attempts < maxAttempts) {
				attempts += 1;
				lastStatus = undefined;
				lastError = undefined;
				let retryable = false;
				let retryAfterMs: number | undefined;

				try {
					const response = await fetchImpl(url, {
						method: "POST",
						headers,
						body,
						// A redirect would re-send the signed request to an unvalidated location.
						redirect: "manual",
						signal: AbortSignal.timeout(timeoutMs),
					});
					lastStatus = response.status;
					if (isSuccessStatus(response.status)) {
						await discardBody(response);
						return { ok: true, attempts, status: response.status };
					}
					retryable = isRetryableStatus(response.status);
					retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
					await discardBody(response);
				} catch (cause) {
					lastError = toError(cause);
					retryable = true;
				}

				if (!retryable || attempts >= maxAttempts) {
					break;
				}
				// Retry-After wins over backoff, but is capped to maxMs.
				const delay =
					retryAfterMs !== undefined
						? Math.min(retryAfterMs, maxMs)
						: backoffDelay(attempts, baseMs, maxMs, random);
				await sleep(delay);
			}

			if (onDeadLetter) {
				const letter: DeadLetter = {
					url,
					event,
					id,
					attempts,
					lastStatus,
					lastError,
				};
				try {
					await onDeadLetter(letter);
				} catch (cause) {
					throw new WebhookSenderError(
						"DEAD_LETTER_CALLBACK_FAILED",
						`dead-letter callback failed after ${attempts} attempt(s) for event ${id}`,
						{ cause },
					);
				}
			}
			return { ok: false, attempts, status: lastStatus };
		},
	};
}

function assertOptions(values: {
	timeoutMs: number;
	maxAttempts: number;
	baseMs: number;
	maxMs: number;
}): void {
	const invalid = (message: string): never => {
		throw new WebhookSenderError("INVALID_OPTIONS", message);
	};
	if (!Number.isFinite(values.timeoutMs) || values.timeoutMs <= 0) {
		invalid("timeoutMs must be a positive number");
	}
	if (!Number.isInteger(values.maxAttempts) || values.maxAttempts < 1) {
		invalid("maxAttempts must be an integer >= 1");
	}
	if (!Number.isFinite(values.baseMs) || values.baseMs < 0) {
		invalid("backoff.baseMs must be a number >= 0");
	}
	if (!Number.isFinite(values.maxMs) || values.maxMs < 0) {
		invalid("backoff.maxMs must be a number >= 0");
	}
}

function assertTargetUrl(url: string, allowInsecureHttp: boolean): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// The input is not included in the message or the cause, since it may contain tokens.
		throw new WebhookSenderError("INVALID_URL", "destination URL is not a valid absolute URL");
	}
	const protocolAllowed =
		parsed.protocol === "https:" || (allowInsecureHttp && parsed.protocol === "http:");
	if (!protocolAllowed) {
		throw new WebhookSenderError(
			"INVALID_URL",
			"destination URL must use https: (allowInsecureHttp enables http: for local development)",
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new WebhookSenderError("INVALID_URL", "destination URL must not contain credentials");
	}
}

function assertEvent(event: WebhookEvent): void {
	if (typeof event.type !== "string" || event.type.length === 0) {
		throw new WebhookSenderError("INVALID_EVENT", "event type must be a non-empty string");
	}
	if (event.id !== undefined && (typeof event.id !== "string" || event.id.length === 0)) {
		throw new WebhookSenderError("INVALID_EVENT", "event id must be a non-empty string");
	}
}

/**
 * Consumes nothing from the receiver body. Cancelling releases the connection. A failed cancel
 * does not change the delivery outcome, which is already determined by the status.
 */
async function discardBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
