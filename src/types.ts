/**
 * Workers Builds の Queue Event Subscription ペイロード。
 * スキーマ: https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/
 *
 * 通知テンプレートを基にしている。
 * https://github.com/cloudflare/templates/tree/main/workers-builds-notifications-template
 */

export interface BuildEvent {
	type: string;
	source: {
		type: string;
		workerName?: string;
	};
	payload: {
		buildUuid: string;
		status: string;
		buildOutcome: "success" | "failure" | "canceled" | "cancelled" | null;
		createdAt: string;
		initializingAt?: string;
		runningAt?: string;
		stoppedAt?: string;
		buildTriggerMetadata?: BuildTriggerMetadata;
	};
	metadata: {
		accountId: string;
		eventSubscriptionId: string;
		eventSchemaVersion: number;
		eventTimestamp: string;
	};
}

export interface BuildTriggerMetadata {
	buildTriggerSource: string;
	branch: string;
	commitHash: string;
	commitMessage: string;
	author: string;
	buildCommand: string;
	deployCommand: string;
	rootDirectory: string;
	repoName: string;
	providerAccountName: string;
	providerType: string;
}

export const BUILD_SUCCEEDED = "cf.workersBuilds.worker.build.succeeded";
export const BUILD_FAILED = "cf.workersBuilds.worker.build.failed";
export const BUILD_CANCELED = "cf.workersBuilds.worker.build.canceled";
export const BUILD_STARTED = "cf.workersBuilds.worker.build.started";
