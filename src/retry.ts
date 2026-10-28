const RETRYABLE_4XX = new Set([408, 425, 429]);

/** Retry on network errors, timeouts, 408, 425, 429 and all 5xx. */
export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_4XX.has(status) || (status >= 500 && status <= 599);
}

export function isSuccessStatus(status: number): boolean {
	return status >= 200 && status <= 299;
}

/**
 * Parses a Retry-After header, either delay-seconds or an HTTP-date.
 * Returns the delay in ms, or `undefined` if the value is absent or invalid.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
	if (value === null) {
		return undefined;
	}
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	const dateMs = Date.parse(trimmed);
	if (Number.isNaN(dateMs)) {
		return undefined;
	}
	return Math.max(0, dateMs - nowMs);
}

/** Full jitter: `random() * min(maxMs, baseMs * 2^(attempt - 1))`. */
export function backoffDelay(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number,
): number {
	return random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}
