export interface WebhookEvent {
	/** Event type, e.g. `"invoice.paid"`. Must be a non-empty string. */
	type: string;
	/** Application payload. Serialized once with `JSON.stringify`. */
	data: unknown;
	/** Stable event ID, sent as `webhook-id`. Generated (`msg_<uuid>`) when omitted. */
	id?: string;
	/** Event time. Fixed at the first attempt and used as `webhook-timestamp`. Defaults to now. */
	timestamp?: Date;
}

export type DeliveryResult =
	| { ok: true; attempts: number; status: number }
	| { ok: false; attempts: number; status?: number };

export interface DeadLetter {
	url: string;
	event: WebhookEvent;
	id: string;
	attempts: number;
	/** Status of the last attempt, if the receiver responded. */
	lastStatus?: number;
	/** Error of the last attempt, if the request failed without a response (network, timeout). */
	lastError?: Error;
}

export interface BackoffOptions {
	/** Base delay in ms. Default: 1000. */
	baseMs?: number;
	/** Upper bound for any single delay (backoff and Retry-After) in ms. Default: 300000. */
	maxMs?: number;
}

export interface WebhookSenderOptions {
	/** Signing secret in Standard Webhooks format: `whsec_<base64>`. */
	secret: string;
	/** Fetch implementation. Default: global `fetch`. */
	fetch?: typeof fetch;
	/** Timeout per attempt in ms. Default: 10000. */
	timeoutMs?: number;
	/** Total attempts including the first one. Default: 5. */
	maxAttempts?: number;
	backoff?: BackoffOptions;
	/** Allow `http:` destination URLs. Intended for local development only. Default: false. */
	allowInsecureHttp?: boolean;
	/** Returns a number in `[0, 1)`. Used for full jitter. Default: `Math.random`. */
	random?: () => number;
	/** Current time in epoch milliseconds. Default: `Date.now`. */
	now?: () => number;
	/** Waits for the given number of milliseconds. Default: `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Called once when delivery has failed for good (non-retryable response or retries exhausted).
	 * Errors thrown here reject `send()` with `DEAD_LETTER_CALLBACK_FAILED`.
	 */
	onDeadLetter?: (letter: DeadLetter) => void | Promise<void>;
}

export interface WebhookSender {
	send(url: string, event: WebhookEvent): Promise<DeliveryResult>;
}
