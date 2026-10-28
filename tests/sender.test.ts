import { describe, expect, it, vi } from "vitest";
import type { DeadLetter, WebhookSenderOptions } from "../src/index";
import { createWebhookSender, WebhookSenderError } from "../src/index";
import { verifyStandardWebhook } from "./helpers/standard-webhooks-verifier";

const KEY = "0123456789abcdef0123456789abcdef";
const SECRET = `whsec_${Buffer.from(KEY).toString("base64")}`;
const NOW_MS = Date.parse("2026-10-28T12:00:00Z");
const TARGET = "https://receiver.example.com/hooks";

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

interface Call {
	url: string;
	init: RequestInit;
	headers: Record<string, string>;
	body: string;
}

/** Scripted fetch. Each call consumes the next step. Sleeps are recorded, not waited for. */
function harness(steps: Step[], overrides: Partial<WebhookSenderOptions> = {}) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			init: init ?? {},
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body as string,
		});
		const step = steps.shift();
		if (step === undefined) {
			throw new Error("unexpected fetch call");
		}
		if (step instanceof Error) {
			throw step;
		}
		if (typeof step === "function") {
			return step(init ?? {});
		}
		return step;
	});
	const sender = createWebhookSender({
		secret: SECRET,
		fetch: fetchMock as unknown as typeof fetch,
		now: () => NOW_MS,
		random: () => 0.5,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		...overrides,
	});
	return { sender, calls, sleeps, fetchMock };
}

const res = (status: number, headers: Record<string, string> = {}): Response =>
	new Response(null, { status, headers });

const EVENT = { type: "invoice.paid", data: { amount: 4200 } };

describe("delivery success", () => {
	it("returns ok after a single 2xx attempt without sleeping", async () => {
		const onDeadLetter = vi.fn();
		const { sender, calls, sleeps } = harness([res(204)], { onDeadLetter });

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: true, attempts: 1, status: 204 });
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
		expect(onDeadLetter).not.toHaveBeenCalled();
	});

	it("sends POST with the Standard Webhooks headers and a verifiable signature", async () => {
		const { sender, calls } = harness([res(200)]);

		await sender.send(TARGET, { ...EVENT, id: "evt_1", timestamp: new Date(NOW_MS) });

		const call = calls[0]!;
		expect(call.url).toBe(TARGET);
		expect(call.init.method).toBe("POST");
		expect(call.headers["content-type"]).toBe("application/json");
		expect(call.headers["webhook-id"]).toBe("evt_1");
		expect(call.headers["webhook-timestamp"]).toBe(String(NOW_MS / 1000));
		expect(call.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
		expect(
			verifyStandardWebhook({
				secret: SECRET,
				headers: call.headers,
				body: call.body,
				nowMs: NOW_MS,
			}),
		).toBe(true);
	});

	it("sends a JSON envelope with type, ISO timestamp and data", async () => {
		const { sender, calls } = harness([res(200)]);

		await sender.send(TARGET, { ...EVENT, timestamp: new Date(NOW_MS) });

		expect(JSON.parse(calls[0]!.body)).toEqual({
			type: "invoice.paid",
			timestamp: new Date(NOW_MS).toISOString(),
			data: { amount: 4200 },
		});
	});

	it("generates a msg_ prefixed id when none is given", async () => {
		const { sender, calls } = harness([res(200)]);

		await sender.send(TARGET, EVENT);

		expect(calls[0]!.headers["webhook-id"]).toMatch(/^msg_[0-9a-f-]{36}$/);
	});

	it("disables redirects so the signed request is never re-sent elsewhere", async () => {
		const { sender, calls } = harness([res(200)]);

		await sender.send(TARGET, EVENT);

		expect(calls[0]!.init.redirect).toBe("manual");
	});
});

describe("retries keep the same bytes, id and signature", () => {
	it("reuses id, timestamp, body and signature across attempts", async () => {
		const { sender, calls } = harness([res(503), res(500), res(200)]);

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: true, attempts: 3, status: 200 });
		expect(calls).toHaveLength(3);
		const [first, ...rest] = calls;
		for (const call of rest) {
			expect(call.body).toBe(first!.body);
			expect(call.headers).toEqual(first!.headers);
		}
	});

	it("keeps the timestamp fixed to the first attempt even if the clock moves", async () => {
		let clock = NOW_MS;
		const { sender, calls } = harness([res(503), res(200)], {
			now: () => clock,
		});

		const pending = sender.send(TARGET, EVENT);
		clock += 60_000;
		await pending;

		expect(calls[0]!.headers["webhook-timestamp"]).toBe(String(NOW_MS / 1000));
		expect(calls[1]!.headers["webhook-timestamp"]).toBe(String(NOW_MS / 1000));
	});

	it("serializes the body exactly once", async () => {
		let serializations = 0;
		const data = {
			toJSON() {
				serializations += 1;
				return { amount: 1 };
			},
		};
		const { sender } = harness([res(503), res(429), res(200)]);

		await sender.send(TARGET, { type: "t", data });

		expect(serializations).toBe(1);
	});
});

describe("retry classification", () => {
	it.each([408, 425, 429, 500, 502, 503, 599])("retries status %i", async (status) => {
		const { sender, calls } = harness([res(status), res(200)]);

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: true, attempts: 2, status: 200 });
		expect(calls).toHaveLength(2);
	});

	it.each([300, 301, 400, 401, 403, 404, 409, 410, 422])(
		"does not retry status %i and dead-letters immediately",
		async (status) => {
			const onDeadLetter = vi.fn();
			const { sender, calls, sleeps } = harness([res(status)], { onDeadLetter });

			const result = await sender.send(TARGET, EVENT);

			expect(result).toEqual({ ok: false, attempts: 1, status });
			expect(calls).toHaveLength(1);
			expect(sleeps).toEqual([]);
			expect(onDeadLetter).toHaveBeenCalledTimes(1);
		},
	);

	it("retries network errors", async () => {
		const { sender, calls } = harness([new TypeError("fetch failed"), res(200)]);

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: true, attempts: 2, status: 200 });
		expect(calls).toHaveLength(2);
	});
});

describe("Retry-After", () => {
	it("honors delay-seconds over backoff", async () => {
		const { sender, sleeps } = harness([res(429, { "retry-after": "7" }), res(200)]);

		await sender.send(TARGET, EVENT);

		expect(sleeps).toEqual([7_000]);
	});

	it("honors an HTTP-date", async () => {
		const date = new Date(NOW_MS + 12_000).toUTCString();
		const { sender, sleeps } = harness([res(503, { "retry-after": date }), res(200)]);

		await sender.send(TARGET, EVENT);

		expect(sleeps).toEqual([12_000]);
	});

	it("treats an HTTP-date in the past as zero delay", async () => {
		const date = new Date(NOW_MS - 60_000).toUTCString();
		const { sender, sleeps } = harness([res(503, { "retry-after": date }), res(200)]);

		await sender.send(TARGET, EVENT);

		expect(sleeps).toEqual([0]);
	});

	it("caps Retry-After to backoff.maxMs", async () => {
		const { sender, sleeps } = harness([res(503, { "retry-after": "999" }), res(200)], {
			backoff: { maxMs: 5_000 },
		});

		await sender.send(TARGET, EVENT);

		expect(sleeps).toEqual([5_000]);
	});

	it("falls back to backoff when Retry-After is invalid", async () => {
		const { sender, sleeps } = harness([res(503, { "retry-after": "soon, maybe" }), res(200)], {
			backoff: { baseMs: 1_000 },
		});

		await sender.send(TARGET, EVENT);

		expect(sleeps).toEqual([500]);
	});

	it("ignores Retry-After on non-retryable statuses", async () => {
		const { sender, calls } = harness([res(400, { "retry-after": "1" })]);

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: false, attempts: 1, status: 400 });
		expect(calls).toHaveLength(1);
	});
});

describe("backoff with full jitter", () => {
	it("delays are random() * min(maxMs, baseMs * 2^(attempt-1))", async () => {
		const { sender, sleeps } = harness([res(503), res(503), res(503), res(503), res(503)], {
			random: () => 0.5,
			backoff: { baseMs: 1_000, maxMs: 3_000 },
		});

		await sender.send(TARGET, EVENT);

		// attempt 1: 0.5*1000, 2: 0.5*2000, 3: 0.5*min(3000,4000), 4: 0.5*min(3000,8000)
		expect(sleeps).toEqual([500, 1_000, 1_500, 1_500]);
	});

	it("stays within [0, bound) for random values at the edges", async () => {
		const low = harness([res(503), res(200)], { random: () => 0 });
		await low.sender.send(TARGET, EVENT);
		expect(low.sleeps).toEqual([0]);

		const high = harness([res(503), res(200)], {
			random: () => 0.999_999,
			backoff: { baseMs: 1_000 },
		});
		await high.sender.send(TARGET, EVENT);
		expect(high.sleeps[0]).toBeGreaterThanOrEqual(0);
		expect(high.sleeps[0]).toBeLessThan(1_000);
	});

	it("does not sleep after the final attempt", async () => {
		const { sender, sleeps } = harness([res(500), res(500), res(500)], {
			maxAttempts: 3,
		});

		await sender.send(TARGET, EVENT);

		expect(sleeps).toHaveLength(2);
	});
});

describe("dead letter", () => {
	it("calls onDeadLetter exactly once after retries are exhausted", async () => {
		const onDeadLetter = vi.fn();
		const { sender } = harness([res(500), res(500), res(502)], {
			maxAttempts: 3,
			onDeadLetter,
		});

		const result = await sender.send(TARGET, { ...EVENT, id: "evt_dead" });

		expect(result).toEqual({ ok: false, attempts: 3, status: 502 });
		expect(onDeadLetter).toHaveBeenCalledTimes(1);
		const letter = onDeadLetter.mock.calls[0]![0] as DeadLetter;
		expect(letter).toMatchObject({
			url: TARGET,
			id: "evt_dead",
			attempts: 3,
			lastStatus: 502,
		});
		expect(letter.event).toEqual({ ...EVENT, id: "evt_dead" });
	});

	it("passes lastError for failures without a response", async () => {
		const onDeadLetter = vi.fn();
		const { sender } = harness([new TypeError("fetch failed")], {
			maxAttempts: 1,
			onDeadLetter,
		});

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: false, attempts: 1, status: undefined });
		const letter = onDeadLetter.mock.calls[0]![0] as DeadLetter;
		expect(letter.lastError).toBeInstanceOf(TypeError);
		expect(letter.lastStatus).toBeUndefined();
	});

	it("reports an error thrown by the callback instead of swallowing it", async () => {
		const callbackError = new Error("persistence down");
		const { sender } = harness([res(500)], {
			maxAttempts: 1,
			onDeadLetter: () => {
				throw callbackError;
			},
		});

		const rejection = sender.send(TARGET, EVENT);

		await expect(rejection).rejects.toBeInstanceOf(WebhookSenderError);
		await expect(rejection).rejects.toMatchObject({
			code: "DEAD_LETTER_CALLBACK_FAILED",
			cause: callbackError,
		});
	});

	it("reports a rejected async callback", async () => {
		const { sender } = harness([res(400)], {
			onDeadLetter: async () => {
				throw new Error("disk full");
			},
		});

		await expect(sender.send(TARGET, EVENT)).rejects.toMatchObject({
			code: "DEAD_LETTER_CALLBACK_FAILED",
		});
	});
});

describe("timeouts and network errors", () => {
	it("aborts an attempt that exceeds timeoutMs and reports TimeoutError", async () => {
		const hang = (init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		const onDeadLetter = vi.fn();
		const { sender, calls } = harness([hang, hang], {
			timeoutMs: 10,
			maxAttempts: 2,
			onDeadLetter,
		});

		const result = await sender.send(TARGET, EVENT);

		expect(result).toEqual({ ok: false, attempts: 2, status: undefined });
		expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
		const letter = onDeadLetter.mock.calls[0]![0] as DeadLetter;
		expect(letter.lastError?.name).toBe("TimeoutError");
	});

	it("retries a timed-out attempt that succeeds later", async () => {
		const hang = (init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		const { sender } = harness([hang, res(200)], { timeoutMs: 10 });

		await expect(sender.send(TARGET, EVENT)).resolves.toEqual({
			ok: true,
			attempts: 2,
			status: 200,
		});
	});
});

describe("URL validation", () => {
	it("rejects http: by default and does not call fetch", async () => {
		const { sender, fetchMock } = harness([res(200)]);

		await expect(sender.send("http://receiver.example.com/hook", EVENT)).rejects.toMatchObject({
			code: "INVALID_URL",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows http: when allowInsecureHttp is set", async () => {
		const { sender, calls } = harness([res(200)], { allowInsecureHttp: true });

		await sender.send("http://localhost:3000/hook", EVENT);

		expect(calls[0]!.url).toBe("http://localhost:3000/hook");
	});

	it("never allows other protocols, even with allowInsecureHttp", async () => {
		const { sender } = harness([res(200)], { allowInsecureHttp: true });

		await expect(sender.send("ftp://example.com/hook", EVENT)).rejects.toMatchObject({
			code: "INVALID_URL",
		});
	});

	it("rejects credentials in the URL", async () => {
		const { sender, fetchMock } = harness([res(200)]);

		await expect(
			sender.send("https://user:pass@receiver.example.com/hook", EVENT),
		).rejects.toMatchObject({ code: "INVALID_URL" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects relative or malformed URLs", async () => {
		const { sender } = harness([res(200)]);

		await expect(sender.send("/hooks/relative", EVENT)).rejects.toMatchObject({
			code: "INVALID_URL",
		});
	});
});

describe("input and option validation", () => {
	it("rejects an empty event type", async () => {
		const { sender } = harness([res(200)]);

		await expect(sender.send(TARGET, { type: "", data: {} })).rejects.toMatchObject({
			code: "INVALID_EVENT",
		});
	});

	it("rejects an empty event id", async () => {
		const { sender } = harness([res(200)]);

		await expect(sender.send(TARGET, { ...EVENT, id: "" })).rejects.toMatchObject({
			code: "INVALID_EVENT",
		});
	});

	it("rejects an invalid timestamp", async () => {
		const { sender } = harness([res(200)]);

		await expect(
			sender.send(TARGET, { ...EVENT, timestamp: new Date("not a date") }),
		).rejects.toMatchObject({ code: "INVALID_EVENT" });
	});

	it("reports circular data as INVALID_EVENT with the TypeError as cause, without calling fetch", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const { sender, fetchMock } = harness([res(200)]);

		const error = await sender.send(TARGET, { type: "x", data: circular }).catch((e) => e);

		expect(error).toBeInstanceOf(WebhookSenderError);
		expect(error).toMatchObject({ code: "INVALID_EVENT" });
		expect(error.cause).toBeInstanceOf(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports BigInt data as INVALID_EVENT", async () => {
		const { sender } = harness([res(200)]);

		await expect(sender.send(TARGET, { type: "x", data: { amount: 1n } })).rejects.toMatchObject({
			code: "INVALID_EVENT",
		});
	});

	it.each([
		["maxAttempts 0", { maxAttempts: 0 }],
		["maxAttempts fractional", { maxAttempts: 1.5 }],
		["timeoutMs 0", { timeoutMs: 0 }],
		["negative backoff.baseMs", { backoff: { baseMs: -1 } }],
	])("rejects %s with INVALID_OPTIONS", (_label, overrides) => {
		expect(() =>
			createWebhookSender({ secret: SECRET, ...overrides } as WebhookSenderOptions),
		).toThrow(WebhookSenderError);
	});
});

describe("secret and body hygiene", () => {
	it("never includes the secret or its key material in errors or dead-letter arguments", async () => {
		const onDeadLetter = vi.fn();
		const { sender } = harness([res(500)], {
			maxAttempts: 1,
			onDeadLetter: () => {
				throw new Error("callback failed");
			},
		});
		const rawKey = Buffer.from(KEY).toString("base64");

		const failure = await sender.send(TARGET, EVENT).catch((error: unknown) => error);
		expect(String((failure as Error).message)).not.toContain(rawKey);
		expect(JSON.stringify(failure)).not.toContain(rawKey);

		const { sender: other } = harness([res(500)], { maxAttempts: 1, onDeadLetter });
		await other.send(TARGET, EVENT);
		expect(JSON.stringify(onDeadLetter.mock.calls[0])).not.toContain(rawKey);
	});

	it("does not read the receiver's response body, only cancels it", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({
			pull() {
				throw new Error("body must not be read");
			},
			cancel,
		});
		const { sender } = harness([new Response(stream, { status: 200 })]);

		await sender.send(TARGET, EVENT);

		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
