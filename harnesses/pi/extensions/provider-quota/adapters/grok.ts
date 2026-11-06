import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class GrokAdapter implements ProviderAdapter {
	readonly id = "grok";
	readonly displayName = "xAI Grok";
	readonly supportedProviders = ["xai", "grok"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.xai || auth.grok || process.env.XAI_API_KEY) return true;
		return ctx.model?.provider === "xai" || ctx.model?.provider === "grok";
	}

	async fetchQuota(
		ctx: ExtensionContext,
		_signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const now = Date.now();
		// Grok 默认两小时滚动配额或周度限额
		const primaryWindow = buildQuotaWindow({
			kind: "rolling",
			label: "Grok 2h",
			remainingPercent: 100,
			windowMinutes: 120,
			resetsAt: now + 2 * 3600 * 1000,
		});

		return {
			providerId: "xai",
			displayName: "xAI Grok",
			planName: "SuperGrok",
			capturedAt: now,
			primaryWindow,
			windows: [primaryWindow],
		};
	}
}
