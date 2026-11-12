/**
 * 通知文面を補う Cloudflare API 呼び出し。
 * 公式テンプレートと同じく、トークンが無い・失敗したときは通知自体は止めない。
 *
 * - 成功: アカウントの workers.dev サブドメインからライブ URL を組む
 * - 失敗: ビルドログからエラー行を拾う
 *
 * 必要なトークン権限（ユーザー向けトークン）:
 * - Workers Builds Configuration: Read
 * - Workers Scripts: Read
 */

import type { BuildEvent } from "./types";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_LOG_PAGES = 50;

interface SubdomainResponse {
	result?: {
		subdomain?: string;
	};
}

interface LogsResponse {
	result?: {
		lines?: [number, string][];
		truncated?: boolean;
		cursor?: string;
	};
}

export async function fetchLiveUrl(event: BuildEvent, env: Env): Promise<string | null> {
	const workerName = event.source.workerName;
	const accountId = event.metadata.accountId;
	const token = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!workerName || !accountId || !token) return null;

	try {
		const response = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			await response.body?.cancel();
			console.error(
				JSON.stringify({
					message: "workers subdomain request failed",
					status: response.status,
					buildUuid: event.payload.buildUuid,
				}),
			);
			return null;
		}
		const data = (await response.json()) as SubdomainResponse;
		const subdomain = data.result?.subdomain;
		if (!subdomain) return null;
		return `https://${workerName}.${subdomain}.workers.dev`;
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "workers subdomain request threw",
				error: error instanceof Error ? error.message : String(error),
				buildUuid: event.payload.buildUuid,
			}),
		);
		return null;
	}
}

export async function fetchBuildLogs(event: BuildEvent, env: Env): Promise<string[]> {
	const accountId = event.metadata.accountId;
	const token = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!accountId || !token) return [];

	const logs: string[] = [];
	let cursor: string | null = null;
	let pageCount = 0;

	try {
		do {
			const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
			const response = await fetch(
				`${API_BASE}/accounts/${accountId}/builds/builds/${event.payload.buildUuid}/logs${query}`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!response.ok) {
				await response.body?.cancel();
				console.error(
					JSON.stringify({
						message: "build logs request failed",
						status: response.status,
						buildUuid: event.payload.buildUuid,
					}),
				);
				break;
			}
			const data = (await response.json()) as LogsResponse;
			if (data.result?.lines) {
				for (const line of data.result.lines) {
					if (typeof line?.[1] === "string") logs.push(line[1]);
				}
			}
			cursor = data.result?.truncated ? (data.result.cursor ?? null) : null;
			pageCount += 1;
		} while (cursor && pageCount < MAX_LOG_PAGES);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "build logs request threw",
				error: error instanceof Error ? error.message : String(error),
				buildUuid: event.payload.buildUuid,
			}),
		);
	}

	return logs;
}
