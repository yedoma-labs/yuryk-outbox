export type WebhookSenderErrorCode =
	| "MALFORMED_SECRET"
	| "INVALID_URL"
	| "INVALID_EVENT"
	| "INVALID_OPTIONS"
	| "DEAD_LETTER_CALLBACK_FAILED";

/**
 * Error thrown for configuration and input problems, and for failures of the dead-letter callback.
 * Messages never contain the signing secret.
 */
export class WebhookSenderError extends Error {
	readonly code: WebhookSenderErrorCode;

	constructor(code: WebhookSenderErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebhookSenderError";
		this.code = code;
	}
}
