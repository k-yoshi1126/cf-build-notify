/**
 * builds-event-subscriptions の consumer。
 * 対応表にある Worker の本番 build.succeeded / build.failed だけ Slack に送る。
 */

import { fetchBuildLogs, fetchLiveUrl } from "./api";
import { decide } from "./routing";
import { buildSlackPayload, postSlack } from "./slack";

export default {
	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			await processMessage(message, env);
		}
	},
} satisfies ExportedHandler<Env, unknown>;

async function processMessage(message: Message<unknown>, env: Env): Promise<void> {
	const decision = decide(message.body);
	if (decision.action === "drop") {
		console.log(
			JSON.stringify({
				message: "dropped build event",
				reason: decision.reason,
				...summarize(message.body),
			}),
		);
		message.ack();
		return;
	}

	const webhookUrl = env[decision.binding]?.trim();
	if (!webhookUrl) {
		console.error(
			JSON.stringify({
				message: "webhook secret is empty",
				binding: decision.binding,
				buildUuid: decision.event.payload.buildUuid,
				workerName: decision.event.source.workerName,
			}),
		);
		message.ack();
		return;
	}

	try {
		const liveUrl =
			decision.kind === "succeeded" ? await fetchLiveUrl(decision.event, env) : null;
		const logs = decision.kind === "failed" ? await fetchBuildLogs(decision.event, env) : [];
		const payload = buildSlackPayload(decision.event, decision.kind, liveUrl, logs);
		const delivered = await postSlack(webhookUrl, payload);
		if (!delivered) {
			message.retry();
			return;
		}
		console.log(
			JSON.stringify({
				message: "sent slack notification",
				kind: decision.kind,
				workerName: decision.event.source.workerName,
				buildUuid: decision.event.payload.buildUuid,
			}),
		);
		message.ack();
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "failed to process build event",
				error: error instanceof Error ? error.message : String(error),
				workerName: decision.event.source.workerName,
				buildUuid: decision.event.payload.buildUuid,
			}),
		);
		message.retry();
	}
}

function summarize(body: unknown): { type?: string; workerName?: string; branch?: string } {
	if (typeof body !== "object" || body === null) return {};
	const record = body as {
		type?: unknown;
		source?: { workerName?: unknown };
		payload?: { buildTriggerMetadata?: { branch?: unknown } };
	};
	return {
		...(typeof record.type === "string" ? { type: record.type } : {}),
		...(typeof record.source?.workerName === "string"
			? { workerName: record.source.workerName }
			: {}),
		...(typeof record.payload?.buildTriggerMetadata?.branch === "string"
			? { branch: record.payload.buildTriggerMetadata.branch }
			: {}),
	};
}
