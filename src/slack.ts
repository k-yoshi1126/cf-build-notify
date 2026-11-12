/**
 * Slack Incoming Webhook 向けの Block Kit。
 * 構成は公式の Workers Builds 通知テンプレートに合わせ、文面は本番の成功と失敗だけ。
 */

import type { BuildEvent } from "./types";
import type { NotifyKind } from "./routing";

interface MrkdwnText {
	type: "mrkdwn";
	text: string;
}

interface SectionBlock {
	type: "section";
	text: MrkdwnText;
	accessory?: {
		type: "button";
		text: { type: "plain_text"; text: string };
		url: string;
		style?: "danger";
	};
}

interface ContextBlock {
	type: "context";
	elements: MrkdwnText[];
}

export interface SlackPayload {
	blocks: Array<SectionBlock | ContextBlock>;
}

export function buildSlackPayload(
	event: BuildEvent,
	kind: NotifyKind,
	liveUrl: string | null,
	logs: string[],
): SlackPayload {
	const workerName = event.source.workerName ?? "worker";
	const dashboardUrl = dashboardUrlFor(event);
	const context = contextElements(event);

	if (kind === "succeeded") {
		const buttonUrl = liveUrl ?? dashboardUrl;
		const blocks: SlackPayload["blocks"] = [
			section(
				`✅ *本番ビルド成功*\n*${workerName}*`,
				buttonUrl ? { text: liveUrl ? "workers.dev を開く" : "ビルドを見る", url: buttonUrl } : undefined,
			),
		];
		if (context.length > 0) blocks.push({ type: "context", elements: context });
		return { blocks };
	}

	const blocks: SlackPayload["blocks"] = [
		section(
			`❌ *本番ビルド失敗*\n*${workerName}*`,
			dashboardUrl ? { text: "ログを見る", url: dashboardUrl, style: "danger" } : undefined,
		),
	];
	if (context.length > 0) blocks.push({ type: "context", elements: context });
	blocks.push({
		type: "section",
		text: { type: "mrkdwn", text: `\`\`\`${extractBuildError(logs)}\`\`\`` },
	});
	return { blocks };
}

export async function postSlack(webhookUrl: string, payload: SlackPayload): Promise<boolean> {
	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		await response.body?.cancel();
		console.error(
			JSON.stringify({
				message: "slack webhook rejected the payload",
				status: response.status,
			}),
		);
		return false;
	}
	await response.body?.cancel();
	return true;
}

function section(
	text: string,
	button?: { text: string; url: string; style?: "danger" },
): SectionBlock {
	const block: SectionBlock = { type: "section", text: { type: "mrkdwn", text } };
	if (button) {
		block.accessory = {
			type: "button",
			text: { type: "plain_text", text: button.text },
			url: button.url,
			...(button.style ? { style: button.style } : {}),
		};
	}
	return block;
}

function contextElements(event: BuildEvent): MrkdwnText[] {
	const meta = event.payload.buildTriggerMetadata;
	if (!meta) return [];
	const elements: MrkdwnText[] = [];
	if (meta.branch) elements.push({ type: "mrkdwn", text: `*Branch:* \`${meta.branch}\`` });
	if (meta.commitHash) {
		const short = meta.commitHash.slice(0, 7);
		const url = commitUrl(event);
		elements.push({
			type: "mrkdwn",
			text: url ? `*Commit:* <${url}|${short}>` : `*Commit:* \`${short}\``,
		});
	}
	const author = authorName(meta.author);
	if (author) elements.push({ type: "mrkdwn", text: `*Author:* ${author}` });
	return elements;
}

function authorName(author: string | undefined): string | null {
	if (!author) return null;
	const at = author.indexOf("@");
	if (at === -1) return author;
	const name = author.slice(0, at);
	return name || author;
}

function commitUrl(event: BuildEvent): string | null {
	const meta = event.payload.buildTriggerMetadata;
	if (!meta?.repoName || !meta.commitHash || !meta.providerAccountName) return null;
	if (meta.providerType === "github") {
		return `https://github.com/${meta.providerAccountName}/${meta.repoName}/commit/${meta.commitHash}`;
	}
	if (meta.providerType === "gitlab") {
		return `https://gitlab.com/${meta.providerAccountName}/${meta.repoName}/-/commit/${meta.commitHash}`;
	}
	return null;
}

function dashboardUrlFor(event: BuildEvent): string | null {
	const accountId = event.metadata.accountId;
	const buildUuid = event.payload.buildUuid;
	const workerName = event.source.workerName;
	if (!accountId || !buildUuid || !workerName) return null;
	return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}

const IGNORE_LINE = [
	/^Total Upload:/i,
	/^Total Size:/i,
	/\/\s*gzip:/i,
	/^Uploaded/i,
	/^Published/i,
	/^Worker Startup Time:/i,
];

const ERROR_LINE = [/^✘\s*\[ERROR\]/i, /^\[ERROR\]/i, /^ERROR:/i, /^Error:/];

export function extractBuildError(logs: string[]): string {
	if (logs.length === 0) return "ログを取得できませんでした";
	for (let i = 0; i < logs.length; i++) {
		const line = logs[i]?.trim() ?? "";
		if (!line || line.startsWith("at ")) continue;
		if (IGNORE_LINE.some((pattern) => pattern.test(line))) continue;
		if (!ERROR_LINE.some((pattern) => pattern.test(line))) continue;
		const next = logs[i + 1]?.trim() ?? "";
		const withContext =
			next && !next.startsWith("at ") && !IGNORE_LINE.some((pattern) => pattern.test(next))
				? `${line}\n${next}`
				: line;
		return truncate(withContext, 500);
	}
	for (let i = logs.length - 1; i >= 0; i--) {
		const line = logs[i]?.trim() ?? "";
		if (line && !IGNORE_LINE.some((pattern) => pattern.test(line))) return truncate(line, 500);
	}
	return "ビルドに失敗しました";
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
