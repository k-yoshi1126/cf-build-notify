import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { BUILD_CANCELED, BUILD_FAILED, BUILD_STARTED } from "../src/types";
import { buildEvent } from "./events";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/webhook";

function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		SLACK_WEBHOOK_AIKEN_OYATSU_LP: WEBHOOK,
		CLOUDFLARE_API_TOKEN: "test-token",
		...overrides,
	};
}

function queued(body: unknown) {
	return {
		id: "msg-1",
		timestamp: new Date(),
		attempts: 1,
		body,
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

async function run(messages: ReturnType<typeof queued>[], env: Env = testEnv()) {
	await worker.queue(
		{
			queue: "builds-event-subscriptions",
			messages,
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
			ackAll() {},
			retryAll() {},
		},
		env,
	);
	return messages;
}

describe("Queue consumer", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function installFetch(handler: (url: string, init?: RequestInit) => Response) {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			calls.push({ url, init });
			return handler(url, init);
		};
		return calls;
	}

	it("本番成功は対応する Webhook に送り、ack する", async () => {
		const calls = installFetch((url) => {
			if (url.includes("/workers/subdomain")) {
				return Response.json({ result: { subdomain: "example" } });
			}
			return new Response("ok");
		});

		const [message] = await run([queued(buildEvent())]);

		expect(message?.ack).toHaveBeenCalledOnce();
		expect(message?.retry).not.toHaveBeenCalled();
		const slack = calls.find((call) => call.url === WEBHOOK);
		expect(slack).toBeDefined();
		const body = JSON.parse(String(slack?.init?.body)) as {
			blocks: Array<{ text?: { text?: string }; accessory?: { url?: string } }>;
		};
		expect(body.blocks[0]?.text?.text).toContain("本番ビルド成功");
		expect(body.blocks[0]?.text?.text).toContain("aiken-oyatsu-lp");
		expect(body.blocks[0]?.accessory?.url).toBe("https://aiken-oyatsu-lp.example.workers.dev");
		expect(calls.some((call) => call.url.includes("api.cloudflare.com"))).toBe(true);
	});

	it("本番失敗はログを取りにいき、失敗通知を送る", async () => {
		const calls = installFetch((url) => {
			if (url.includes("/logs")) {
				return Response.json({
					result: {
						lines: [
							[1, "Installing dependencies..."],
							[2, '✘ [ERROR] Could not resolve "missing-module"'],
						],
						truncated: false,
					},
				});
			}
			return new Response("ok");
		});

		const [message] = await run([
			queued(buildEvent({ type: BUILD_FAILED, outcome: "failure" })),
		]);

		expect(message?.ack).toHaveBeenCalledOnce();
		expect(calls.some((call) => call.url.includes("/builds/builds/") && call.url.includes("/logs"))).toBe(
			true,
		);
		const slack = calls.find((call) => call.url === WEBHOOK);
		const payload = JSON.parse(String(slack?.init?.body)) as {
			blocks: Array<{ text?: { text?: string } }>;
		};
		const text = payload.blocks.map((block) => block.text?.text ?? "").join("\n");
		expect(text).toContain("本番ビルド失敗");
		expect(text).toContain("Could not resolve");
	});

	it.each([
		["開始", buildEvent({ type: BUILD_STARTED, outcome: null })],
		["キャンセル", buildEvent({ type: BUILD_CANCELED, outcome: "canceled" })],
		["プレビュー成功", buildEvent({ branch: "feature/header" })],
		["プレビュー失敗", buildEvent({ type: BUILD_FAILED, branch: "feature/header", outcome: "failure" })],
		["表に無い Worker", buildEvent({ workerName: "other-worker" })],
	])("%s は送らず ack する", async (_label, event) => {
		const calls = installFetch(() => new Response("should not be called", { status: 500 }));
		const [message] = await run([queued(event)]);
		expect(calls).toHaveLength(0);
		expect(message?.ack).toHaveBeenCalledOnce();
		expect(message?.retry).not.toHaveBeenCalled();
	});

	it("同じバッチでも捨てるイベントは送らない", async () => {
		const calls = installFetch((url) => {
			if (url.includes("/workers/subdomain")) {
				return Response.json({ result: { subdomain: "example" } });
			}
			return new Response("ok");
		});
		const messages = [
			queued(buildEvent({ type: BUILD_STARTED, outcome: null })),
			queued(buildEvent()),
			queued(buildEvent({ workerName: "other-worker" })),
		];
		await run(messages);
		expect(calls.filter((call) => call.url === WEBHOOK)).toHaveLength(1);
		expect(messages[0]?.ack).toHaveBeenCalledOnce();
		expect(messages[1]?.ack).toHaveBeenCalledOnce();
		expect(messages[2]?.ack).toHaveBeenCalledOnce();
	});

	it("Slack が失敗したら retry し、ack しない", async () => {
		installFetch((url) => {
			if (url === WEBHOOK) return new Response("invalid_payload", { status: 400 });
			return Response.json({ result: { subdomain: "example" } });
		});
		const [message] = await run([queued(buildEvent())]);
		expect(message?.retry).toHaveBeenCalledOnce();
		expect(message?.ack).not.toHaveBeenCalled();
	});

	it("Webhook Secret が空なら送らず ack する", async () => {
		const calls = installFetch(() => new Response("no"));
		const [message] = await run(
			[queued(buildEvent())],
			testEnv({ SLACK_WEBHOOK_AIKEN_OYATSU_LP: "  " }),
		);
		expect(calls).toHaveLength(0);
		expect(message?.ack).toHaveBeenCalledOnce();
		expect(message?.retry).not.toHaveBeenCalled();
	});

	it("API トークンが空でも本番成功は通知し、Cloudflare API は呼ばない", async () => {
		const calls = installFetch(() => new Response("ok"));
		const [message] = await run(
			[queued(buildEvent())],
			testEnv({ CLOUDFLARE_API_TOKEN: "" }),
		);
		expect(message?.ack).toHaveBeenCalledOnce();
		expect(calls.map((call) => call.url)).toEqual([WEBHOOK]);
		const payload = JSON.parse(String(calls[0]?.init?.body)) as {
			blocks: Array<{ text?: { text?: string }; accessory?: { text?: { text?: string } } }>;
		};
		expect(payload.blocks[0]?.text?.text).toContain("本番ビルド成功");
		expect(payload.blocks[0]?.accessory?.text?.text).toBe("ビルドを見る");
	});
});
