import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Independent receiver-side verifier for the Standard Webhooks signature scheme.
 * It is written from the specification and shares no code with the library under test.
 */
export function verifyStandardWebhook(options: {
	secret: string;
	headers: Record<string, string>;
	body: string;
	nowMs: number;
	toleranceSeconds?: number;
}): boolean {
	const { secret, headers, body, nowMs } = options;
	const tolerance = options.toleranceSeconds ?? 300;

	const id = headers["webhook-id"];
	const timestamp = headers["webhook-timestamp"];
	const signatureHeader = headers["webhook-signature"];
	if (!id || !timestamp || !signatureHeader || !/^\d+$/.test(timestamp)) {
		return false;
	}
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > tolerance) {
		return false;
	}
	if (!secret.startsWith("whsec_")) {
		return false;
	}

	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

	return signatureHeader.split(" ").some((candidate) => {
		const [version, value] = candidate.split(",");
		if (version !== "v1" || !value) {
			return false;
		}
		const given = Buffer.from(value, "base64");
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}
