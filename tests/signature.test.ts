import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWebhookSender } from "../src/index";
import { verifyStandardWebhook } from "./helpers/standard-webhooks-verifier";

const KEY = "0123456789abcdef0123456789abcdef";
const SECRET = `whsec_${Buffer.from(KEY).toString("base64")}`;
const ID = "evt_reference_0001";
const TIMESTAMP_SECONDS = 1_800_000_000;
const NOW_MS = TIMESTAMP_SECONDS * 1000;
const EVENT = { type: "invoice.paid", data: { amount: 4200, currency: "EUR" } };
const EXPECTED_BODY = JSON.stringify({
	type: "invoice.paid",
	timestamp: new Date(NOW_MS).toISOString(),
	data: { amount: 4200, currency: "EUR" },
});

describe("signature reference vector", () => {
	it("matches an HMAC-SHA256 computed directly with node:crypto and passes the verifier", async () => {
		const expectedSignature = `v1,${createHmac("sha256", Buffer.from(KEY))
			.update(`${ID}.${TIMESTAMP_SECONDS}.${EXPECTED_BODY}`)
			.digest("base64")}`;

		let captured: { headers: Record<string, string>; body: string } | undefined;
		const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
			captured = {
				headers: init?.headers as Record<string, string>,
				body: init?.body as string,
			};
			return new Response(null, { status: 200 });
		};
		const sender = createWebhookSender({
			secret: SECRET,
			fetch: fetchMock as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		await sender.send("https://receiver.example.com/hook", { ...EVENT, id: ID });

		expect(captured).toBeDefined();
		const { headers, body } = captured!;
		expect(body).toBe(EXPECTED_BODY);
		expect(headers["webhook-id"]).toBe(ID);
		expect(headers["webhook-timestamp"]).toBe(String(TIMESTAMP_SECONDS));
		expect(headers["webhook-signature"]).toBe(expectedSignature);
		expect(verifyStandardWebhook({ secret: SECRET, headers, body, nowMs: NOW_MS })).toBe(true);
	});

	it("the verifier rejects a tampered body", () => {
		const signature = `v1,${createHmac("sha256", Buffer.from(KEY))
			.update(`${ID}.${TIMESTAMP_SECONDS}.${EXPECTED_BODY}`)
			.digest("base64")}`;
		const headers = {
			"webhook-id": ID,
			"webhook-timestamp": String(TIMESTAMP_SECONDS),
			"webhook-signature": signature,
		};
		expect(
			verifyStandardWebhook({
				secret: SECRET,
				headers,
				body: EXPECTED_BODY.replace("4200", "1"),
				nowMs: NOW_MS,
			}),
		).toBe(false);
	});

	it("the verifier rejects timestamps outside the 5 minute tolerance", () => {
		const signature = `v1,${createHmac("sha256", Buffer.from(KEY))
			.update(`${ID}.${TIMESTAMP_SECONDS}.${EXPECTED_BODY}`)
			.digest("base64")}`;
		const headers = {
			"webhook-id": ID,
			"webhook-timestamp": String(TIMESTAMP_SECONDS),
			"webhook-signature": signature,
		};
		expect(
			verifyStandardWebhook({
				secret: SECRET,
				headers,
				body: EXPECTED_BODY,
				nowMs: NOW_MS + 301_000,
			}),
		).toBe(false);
	});
});
