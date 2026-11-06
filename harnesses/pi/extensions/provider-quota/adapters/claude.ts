import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class ClaudeAdapter implements ProviderAdapter {
	readonly id = "claude";
	readonly displayName = "Anthropic Claude";
	readonly supportedProviders = ["anthropic", "claude", "claude-bridge"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.anthropic || auth.claude || process.env.ANTHROPIC_API_KEY) return true;
		return (
			ctx.model?.provider === "anthropic" ||
			ctx.model?.provider === "claude" ||
			ctx.model?.provider === "claude-bridge"
		);
	}

	async fetchQuota(
		ctx: ExtensionContext,
		_signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const now = Date.now();
		const reset5h = now + 5 * 3600 * 1000;

		// Claude 默认 5 小时滚动周期与周度额度
		const primaryWindow = buildQuotaWindow({
			kind: "rolling",
			label: "Claude 5h",
			remainingPercent: 100,
			windowMinutes: 300,
			resetsAt: reset5h,
		});

		const weeklyWindow = buildQuotaWindow({
			kind: "weekly",
			label: "Claude 周度",
			remainingPercent: 100,
			windowMinutes: 10080,
			resetsAt: now + 7 * 24 * 3600 * 1000,
		});

		return {
			providerId: "anthropic",
			displayName: "Anthropic Claude",
			planName: "Pro/Max",
			capturedAt: now,
			primaryWindow,
			windows: [primaryWindow, weeklyWindow],
		};
	}
}
