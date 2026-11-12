/**
 * 通知するイベントの絞り込みと、Worker 名から Slack Webhook Secret への振り分け。
 *
 * 本番判定:
 * 公式スキーマに environment や isPreview は無い。Workers Builds は
 * 本番ブランチへの push を本番ビルド、それ以外のブランチをプレビューにする
 * （https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/）。
 * イベントに載るのは `payload.buildTriggerMetadata.branch` だけなので、
 * 公式テンプレートと同じく、ブランチ名が main / master / production / prod
 * （大文字小文字は区別しない）のときだけ本番とみなす。
 * ブランチが無いイベントは本番だと確認できないので捨てる。
 * テンプレートはブランチ欠落を本番扱いにするが、この Worker は本番だけ送る。
 */

import {
	BUILD_CANCELED,
	BUILD_FAILED,
	BUILD_SUCCEEDED,
	type BuildEvent,
} from "./types";

/** Worker 名（wrangler の name）→ Secret のバインディング名。 */
export const WORKER_WEBHOOK_BINDINGS = {
	"aiken-oyatsu-lp": "SLACK_WEBHOOK_AIKEN_OYATSU_LP",
} as const;

export type WebhookBindingName =
	(typeof WORKER_WEBHOOK_BINDINGS)[keyof typeof WORKER_WEBHOOK_BINDINGS];

/** 公式テンプレートの本番ブランチ名。Workers Builds の初期値はリポジトリのデフォルトブランチ。 */
export const PRODUCTION_BRANCHES = ["main", "master", "production", "prod"] as const;

export type NotifyKind = "succeeded" | "failed";

export type DropReason =
	| "invalid"
	| "ignored-type"
	| "canceled"
	| "not-production"
	| "unmapped-worker";

export type Decision =
	| {
			action: "notify";
			binding: WebhookBindingName;
			kind: NotifyKind;
			event: BuildEvent;
	  }
	| { action: "drop"; reason: DropReason };

export function isProductionBranch(branch: string | undefined): boolean {
	if (!branch) return false;
	const normalized = branch.toLowerCase();
	return (PRODUCTION_BRANCHES as readonly string[]).includes(normalized);
}

export function decide(body: unknown): Decision {
	const event = parseBuildEvent(body);
	if (!event) return { action: "drop", reason: "invalid" };

	if (event.type === BUILD_CANCELED || isCanceledOutcome(event)) {
		return { action: "drop", reason: "canceled" };
	}

	const kind = notifyKind(event.type);
	if (!kind) return { action: "drop", reason: "ignored-type" };

	const branch = event.payload.buildTriggerMetadata?.branch;
	if (!isProductionBranch(branch)) {
		return { action: "drop", reason: "not-production" };
	}

	const binding = bindingFor(event.source.workerName);
	if (!binding) return { action: "drop", reason: "unmapped-worker" };

	return { action: "notify", binding, kind, event };
}

function bindingFor(workerName: string | undefined): WebhookBindingName | undefined {
	if (!workerName) return undefined;
	if (!Object.prototype.hasOwnProperty.call(WORKER_WEBHOOK_BINDINGS, workerName)) {
		return undefined;
	}
	return WORKER_WEBHOOK_BINDINGS[workerName as keyof typeof WORKER_WEBHOOK_BINDINGS];
}

function notifyKind(type: string): NotifyKind | null {
	if (type === BUILD_SUCCEEDED) return "succeeded";
	if (type === BUILD_FAILED) return "failed";
	return null;
}

function isCanceledOutcome(event: BuildEvent): boolean {
	const outcome = event.payload.buildOutcome;
	return outcome === "canceled" || outcome === "cancelled";
}

function parseBuildEvent(body: unknown): BuildEvent | null {
	if (!isRecord(body)) return null;
	if (typeof body.type !== "string" || body.type.length === 0) return null;
	if (!isRecord(body.source) || typeof body.source.type !== "string") return null;
	if (body.source.workerName !== undefined && typeof body.source.workerName !== "string") {
		return null;
	}
	if (!isRecord(body.payload)) return null;
	const outcome = body.payload.buildOutcome;
	if (!isBuildOutcome(outcome)) return null;
	if (typeof body.payload.buildUuid !== "string") return null;
	if (typeof body.payload.status !== "string") return null;
	if (typeof body.payload.createdAt !== "string") return null;
	if (!isRecord(body.metadata) || typeof body.metadata.accountId !== "string") return null;

	const trigger = parseTriggerMetadata(body.payload.buildTriggerMetadata);
	if (trigger === "invalid") return null;

	return {
		type: body.type,
		source: {
			type: body.source.type,
			...(typeof body.source.workerName === "string"
				? { workerName: body.source.workerName }
				: {}),
		},
		payload: {
			buildUuid: body.payload.buildUuid,
			status: body.payload.status,
			buildOutcome: outcome,
			createdAt: body.payload.createdAt,
			...(typeof body.payload.initializingAt === "string"
				? { initializingAt: body.payload.initializingAt }
				: {}),
			...(typeof body.payload.runningAt === "string"
				? { runningAt: body.payload.runningAt }
				: {}),
			...(typeof body.payload.stoppedAt === "string"
				? { stoppedAt: body.payload.stoppedAt }
				: {}),
			...(trigger ? { buildTriggerMetadata: trigger } : {}),
		},
		metadata: {
			accountId: body.metadata.accountId,
			eventSubscriptionId: stringOrEmpty(body.metadata.eventSubscriptionId),
			eventSchemaVersion:
				typeof body.metadata.eventSchemaVersion === "number"
					? body.metadata.eventSchemaVersion
					: 0,
			eventTimestamp: stringOrEmpty(body.metadata.eventTimestamp),
		},
	};
}

function parseTriggerMetadata(value: unknown): BuildEvent["payload"]["buildTriggerMetadata"] | "invalid" {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "invalid";
	if (value.branch !== undefined && typeof value.branch !== "string") return "invalid";
	return {
		buildTriggerSource: stringOrEmpty(value.buildTriggerSource),
		branch: typeof value.branch === "string" ? value.branch : "",
		commitHash: stringOrEmpty(value.commitHash),
		commitMessage: stringOrEmpty(value.commitMessage),
		author: stringOrEmpty(value.author),
		buildCommand: stringOrEmpty(value.buildCommand),
		deployCommand: stringOrEmpty(value.deployCommand),
		rootDirectory: stringOrEmpty(value.rootDirectory),
		repoName: stringOrEmpty(value.repoName),
		providerAccountName: stringOrEmpty(value.providerAccountName),
		providerType: stringOrEmpty(value.providerType),
	};
}

function isBuildOutcome(
	value: unknown,
): value is BuildEvent["payload"]["buildOutcome"] {
	return (
		value === null ||
		value === "success" ||
		value === "failure" ||
		value === "canceled" ||
		value === "cancelled"
	);
}

function stringOrEmpty(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
