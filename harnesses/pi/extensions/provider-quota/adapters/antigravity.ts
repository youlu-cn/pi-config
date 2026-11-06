import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class AntigravityAdapter implements ProviderAdapter {
	readonly id = "antigravity";
	readonly displayName = "Google Antigravity";
	readonly supportedProviders = ["antigravity"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.antigravity || auth["google-antigravity"]) return true;
		return ctx.model?.provider === "antigravity";
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const auth = loadAuthStorage();
		const entry = auth.antigravity || auth["google-antigravity"] || {};
		const token = entry.access_token || entry.token || process.env.ANTIGRAVITY_TOKEN;

		// 默认构建兜底报告（即使未能连通实际接口，也能安全降级）
		const now = Date.now();
		// 计算到下一个 UTC 午夜的重置时间
		const nextMidnight = new Date();
		nextMidnight.setUTCHours(24, 0, 0, 0);

		// 如果有实际 token，可请求 Google API 获取实时配额详情
		// 此处保留接口调用通道，超时或失败均平滑降级
		let remainingPercent = 100;
		if (token) {
			try {
				const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"User-Agent": "antigravity/1.4.0",
					},
					body: JSON.stringify({
						metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED" },
					}),
					signal,
				});
				if (res.ok) {
					// 成功解析实际配额响应
					const data = (await res.json()) as any;
					if (typeof data?.quotaRemainingPercent === "number") {
						remainingPercent = data.quotaRemainingPercent;
					}
				}
			} catch {
				// 网络或鉴权失败时，静默保底
			}
		}

		const primaryWindow = buildQuotaWindow({
			kind: "daily",
			label: "Gemini 每日",
			remainingPercent,
			resetsAt: nextMidnight.getTime(),
		});

		return {
			providerId: "antigravity",
			displayName: "Google Antigravity",
			accountEmail: entry.email,
			capturedAt: now,
			primaryWindow,
			windows: [primaryWindow],
		};
	}
}
