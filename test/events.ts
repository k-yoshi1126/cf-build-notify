import { BUILD_FAILED, BUILD_SUCCEEDED } from "../src/types";

export interface EventOverrides {
	type?: string;
	workerName?: string | null;
	branch?: string | null;
	outcome?: "success" | "failure" | "canceled" | "cancelled" | null;
	omitTrigger?: boolean;
}

export function buildEvent(overrides: EventOverrides = {}): Record<string, unknown> {
	const type = overrides.type ?? BUILD_SUCCEEDED;
	const workerName = overrides.workerName === undefined ? "aiken-oyatsu-lp" : overrides.workerName;
	const branch = overrides.branch === undefined ? "main" : overrides.branch;
	const outcome =
		overrides.outcome === undefined
			? type === BUILD_FAILED
				? "failure"
				: "success"
			: overrides.outcome;

	const payload: Record<string, unknown> = {
		buildUuid: "build-12345678-90ab-cdef-1234-567890abcdef",
		status: type.endsWith("failed") ? "failed" : "success",
		buildOutcome: outcome,
		createdAt: "2025-05-01T02:48:57.132Z",
		stoppedAt: "2025-05-01T02:50:15.132Z",
	};
	if (!overrides.omitTrigger) {
		payload.buildTriggerMetadata = {
			buildTriggerSource: "push_event",
			...(branch === null ? {} : { branch }),
			commitHash: "abc123def456",
			commitMessage: "Fix bug in authentication",
			author: "developer@example.com",
			buildCommand: "npm run build",
			deployCommand: "npx wrangler deploy",
			rootDirectory: "/",
			repoName: "aiken-oyatsu-lp",
			providerAccountName: "k-yoshi1126",
			providerType: "github",
		};
	}

	return {
		type,
		source: {
			type: "workersBuilds.worker",
			...(workerName === null ? {} : { workerName }),
		},
		payload,
		metadata: {
			accountId: "account-id",
			eventSubscriptionId: "sub-id",
			eventSchemaVersion: 1,
			eventTimestamp: "2025-05-01T02:48:57.132Z",
		},
	};
}
