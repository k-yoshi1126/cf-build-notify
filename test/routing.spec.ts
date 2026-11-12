import { describe, expect, it } from "vitest";
import { decide, isProductionBranch, WORKER_WEBHOOK_BINDINGS } from "../src/routing";
import {
	BUILD_CANCELED,
	BUILD_FAILED,
	BUILD_STARTED,
	BUILD_SUCCEEDED,
} from "../src/types";
import { buildEvent } from "./events";

describe("本番ブランチ", () => {
	it.each(["main", "master", "production", "prod", "Main", "MASTER"])(
		"%s は本番",
		(branch) => {
			expect(isProductionBranch(branch)).toBe(true);
		},
	);

	it.each(["feature/header", "preview", "develop", "main-backup", "", undefined])(
		"%s は本番ではない",
		(branch) => {
			expect(isProductionBranch(branch)).toBe(false);
		},
	);
});

describe("振り分けと絞り込み", () => {
	it("本番の成功は aiken-oyatsu-lp の Webhook Secret に振り分ける", () => {
		const decision = decide(buildEvent({ type: BUILD_SUCCEEDED, branch: "main" }));
		expect(decision).toMatchObject({
			action: "notify",
			kind: "succeeded",
			binding: "SLACK_WEBHOOK_AIKEN_OYATSU_LP",
		});
	});

	it("本番の失敗も同じ Webhook Secret に振り分ける", () => {
		const decision = decide(
			buildEvent({ type: BUILD_FAILED, branch: "master", outcome: "failure" }),
		);
		expect(decision).toMatchObject({
			action: "notify",
			kind: "failed",
			binding: WORKER_WEBHOOK_BINDINGS["aiken-oyatsu-lp"],
		});
	});

	it.each(["production", "prod", "MAIN"])("ブランチ %s の失敗は通知する", (branch) => {
		expect(decide(buildEvent({ type: BUILD_FAILED, branch, outcome: "failure" })).action).toBe(
			"notify",
		);
	});

	it("開始イベントは捨てる", () => {
		expect(decide(buildEvent({ type: BUILD_STARTED, outcome: null })).action).toBe("drop");
		expect(decide(buildEvent({ type: BUILD_STARTED, outcome: null }))).toMatchObject({
			reason: "ignored-type",
		});
	});

	it("キャンセルは捨てる", () => {
		expect(decide(buildEvent({ type: BUILD_CANCELED, outcome: "canceled" }))).toMatchObject({
			action: "drop",
			reason: "canceled",
		});
	});

	it("failed 型でも outcome が cancelled なら捨てる", () => {
		expect(
			decide(buildEvent({ type: BUILD_FAILED, outcome: "cancelled", branch: "main" })),
		).toMatchObject({ action: "drop", reason: "canceled" });
	});

	it("本番ブランチ以外の成功は捨てる", () => {
		expect(
			decide(buildEvent({ type: BUILD_SUCCEEDED, branch: "feature/header" })),
		).toMatchObject({ action: "drop", reason: "not-production" });
	});

	it("本番ブランチ以外の失敗も捨てる", () => {
		expect(
			decide(buildEvent({ type: BUILD_FAILED, branch: "preview", outcome: "failure" })),
		).toMatchObject({ action: "drop", reason: "not-production" });
	});

	it("ブランチが無い成功は捨てる", () => {
		expect(decide(buildEvent({ branch: null }))).toMatchObject({
			action: "drop",
			reason: "not-production",
		});
		expect(decide(buildEvent({ omitTrigger: true }))).toMatchObject({
			action: "drop",
			reason: "not-production",
		});
	});

	it("対応表に無い Worker の本番成功は捨てる", () => {
		expect(decide(buildEvent({ workerName: "other-worker" }))).toMatchObject({
			action: "drop",
			reason: "unmapped-worker",
		});
	});

	it("Worker 名が無い本番成功は捨てる", () => {
		expect(decide(buildEvent({ workerName: null }))).toMatchObject({
			action: "drop",
			reason: "unmapped-worker",
		});
	});

	it("Worker 名の大文字小文字が違うものは捨てる", () => {
		expect(decide(buildEvent({ workerName: "Aiken-Oyatsu-LP" }))).toMatchObject({
			action: "drop",
			reason: "unmapped-worker",
		});
	});

	it("壊れたメッセージは捨てる", () => {
		expect(decide(null)).toMatchObject({ action: "drop", reason: "invalid" });
		expect(decide({ type: BUILD_SUCCEEDED })).toMatchObject({
			action: "drop",
			reason: "invalid",
		});
	});
});
