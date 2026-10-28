import { createHmac } from "node:crypto";

/**
 * Computes the Standard Webhooks signature `v1,<base64 HMAC-SHA256>` over `<id>.<timestamp>.<body>`.
 * `timestamp` is in whole seconds.
 */
export function signPayload(key: Buffer, id: string, timestamp: number, body: string): string {
	const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
	return `v1,${digest}`;
}
