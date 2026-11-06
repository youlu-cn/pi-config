import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class GptAdapter implements ProviderAdapter {
	readonly id = "gpt";
	readonly displayName = "OpenAI / GPT";
	readonly supportedProviders = ["openai", "openai-codex"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.openai || auth["openai-codex"] || process.env.OPENAI_API_KEY) return true;
		return (
			ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex"
		);
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const auth = loadAuthStorage();
		const entry = auth["openai-codex"] || auth.openai || {};
		const token = entry.access_token || entry.apiKey || process.env.OPENAI_API_KEY;

		const now = Date.now();
		// 默认 5 小时滚动重置窗口
		const reset5h = now + 5 * 3600 * 1000;
		let remainingPercent = 100;

		// 若存在有效 OAuth，可发起真实查询
		if (token && typeof token === "string" && token.startsWith("eyJ")) {
			try {
				const res = await fetch("https://chatgpt.com/backend-api/compliance/user", {
					headers: { Authorization: `Bearer ${token}` },
					signal,
				});
				if (res.ok) {
					const data = (await res.json()) as any;
					if (typeof data?.rate_limit?.remaining_percent === "number") {
						remainingPercent = data.rate_limit.remaining_percent;
					}
				}
			} catch {
				// 静默保底
			}
		}

		const primaryWindow = buildQuotaWindow({
			kind: "rolling",
			label: "GPT 5h窗口",
			remainingPercent,
			windowMinutes: 300,
			resetsAt: reset5h,
		});

		return {
			providerId: "openai-codex",
			displayName: "OpenAI / GPT",
			accountEmail: entry.email,
			planName: entry.plan || "Plus/Team",
			capturedAt: now,
			primaryWindow,
			windows: [primaryWindow],
		};
	}
}
