import { describe, expect, it } from "vitest";
import { createWebhookSender, WebhookSenderError } from "../src/index";
import { decodeSecret } from "../src/secret";

const KEY = "0123456789abcdef0123456789abcdef";
const VALID = `whsec_${Buffer.from(KEY).toString("base64")}`;

describe("decodeSecret", () => {
	it("decodes a whsec_ base64 secret into the raw key bytes", () => {
		expect(decodeSecret(VALID).toString("utf8")).toBe(KEY);
	});

	it.each([
		["missing prefix", Buffer.from(KEY).toString("base64")],
		["empty payload", "whsec_"],
		["wrong prefix case", `WHSEC_${Buffer.from(KEY).toString("base64")}`],
		["invalid characters", "whsec_@@@@"],
		["bad length (not multiple of 4)", "whsec_abcde"],
		["non-canonical base64", "whsec_QR=="],
		["whitespace inside", "whsec_MDEy MzQ1"],
	])("rejects %s with MALFORMED_SECRET", (_label, secret) => {
		expect(() => decodeSecret(secret)).toThrow(WebhookSenderError);
		try {
			decodeSecret(secret);
		} catch (error) {
			expect((error as WebhookSenderError).code).toBe("MALFORMED_SECRET");
		}
	});

	it("does not include the secret in the error message", () => {
		const secret = "whsec_@@not-base64-but-secret-material";
		try {
			decodeSecret(secret);
			expect.unreachable("decodeSecret should have thrown");
		} catch (error) {
			expect((error as Error).message).not.toContain("secret-material");
		}
	});

	it("is enforced by createWebhookSender at creation time", () => {
		expect(() => createWebhookSender({ secret: "not-a-secret" })).toThrow(WebhookSenderError);
	});
});
