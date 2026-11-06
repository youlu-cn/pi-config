import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModelRouter, AUTO_MODEL_STATUS_EVENT } from "./router.ts";

test("AutoModelRouter status bar updates and formatting", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "auto-model-router-int-"));
	try {
		let statusKey = "";
		let statusText = "";
		let notifiedText = "";
		let broadcastedData: any;

		const mockPi: any = {
			setModel: async () => true,
			appendEntry: () => {},
			events: {
				emit(channel: string, data: any) {
					if (channel === AUTO_MODEL_STATUS_EVENT) {
						broadcastedData = data;
					}
				},
			},
		};

		const router = new AutoModelRouter(mockPi, process.cwd(), tempDir);

		const mockCtx: any = {
			hasUI: true,
			cwd: process.cwd(),
			model: { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			modelRegistry: {
				find: () => undefined,
				getAll: () => [],
			},
			ui: {
				setStatus(key: string, text: string) {
					statusKey = key;
					statusText = text;
				},
				notify(text: string) {
					notifiedText = text;
				},
			},
		};

		// 1. Auto 开启状态：广播给 session-ui，右侧只保留环境指标（无 Auto 和模型冗余）
		router.updateStatusBar(mockCtx);

		assert.equal(statusKey, "auto-model-router");
		assert.ok(broadcastedData);
		assert.equal(broadcastedData.enabled, true);
		assert.ok(statusText.includes("📦"));
		assert.ok(statusText.includes("⏱️"));
		assert.equal(statusText.includes("🤖 Auto"), false); // 右侧不再冗余显示 Auto

		// 2. 命令流转测试
		router.rescan(mockCtx);
		assert.equal(router.phase, "SCOUT");
		assert.ok(notifiedText.includes("清除"));

		router.requestPlan(mockCtx);
		assert.equal(router.phase, "PLAN");
		assert.ok(notifiedText.includes("Argon"));

		// 3. Auto 关闭状态：用户要求“右侧什么都不用留”
		await router.toggleAuto(mockCtx);
		assert.equal(router.isAutoEnabled, false);
		assert.equal(broadcastedData.enabled, false);
		assert.equal(statusText, ""); // 右侧完全清空
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
