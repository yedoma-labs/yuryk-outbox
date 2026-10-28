import { WebhookSenderError } from "./errors";

const PREFIX = "whsec_";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes a Standard Webhooks secret (`whsec_<base64>`) into the raw HMAC key bytes.
 * Throws `MALFORMED_SECRET` without including the secret in the message.
 */
export function decodeSecret(secret: string): Buffer {
	const malformed = (): WebhookSenderError =>
		new WebhookSenderError("MALFORMED_SECRET", "secret must have the format whsec_<base64>");

	if (!secret.startsWith(PREFIX)) {
		throw malformed();
	}
	const encoded = secret.slice(PREFIX.length);
	if (encoded.length === 0 || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
		throw malformed();
	}
	const key = Buffer.from(encoded, "base64");
	// Round-trip check rejects non-canonical base64 that Buffer would silently accept.
	if (key.length === 0 || key.toString("base64") !== encoded) {
		throw malformed();
	}
	return key;
}
