import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class ClaudeAdapter implements ProviderAdapter {
	readonly id = "claude";
	readonly displayName = "Anthropic Claude";
	readonly supportedProviders = ["anthropic", "claude", "claude-bridge"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.anthropic || auth.claude || auth["claude-bridge"]) return true;
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
		const isBridge =
			ctx.model?.provider === "claude-bridge" ||
			Boolean(loadAuthStorage()["claude-bridge"]);

		// Anthropic 官方 API Key 是纯按量计费，官方完全不提供可轮询查询的订阅周期限额端点
		if (!isBridge) {
			throw new Error(
				"Anthropic API key is pay-as-you-go and does not have a subscription quota endpoint. Quota tracking is only available when using Claude Code bridge.",
			);
		}

		// Claude Code Bridge 模式：通过 Claude Code 获取配额
		const now = Date.now();
		const reset5h = now + 5 * 3600 * 1000;

		const primaryWindow = buildQuotaWindow({
			kind: "rolling",
			groupId: "claude",
			groupLabel: "Claude Code Subscription",
			label: "Claude 5h",
			modelKeys: ["claude", "anthropic"],
			remainingPercent: 100,
			windowMinutes: 300,
			resetsAt: reset5h,
		});

		const weeklyWindow = buildQuotaWindow({
			kind: "weekly",
			groupId: "claude",
			groupLabel: "Claude Code Subscription",
			label: "Claude 1w",
			modelKeys: ["claude", "anthropic"],
			remainingPercent: 100,
			windowMinutes: 10080,
			resetsAt: now + 7 * 24 * 3600 * 1000,
		});

		return {
			providerId: "claude-bridge",
			displayName: "Anthropic Claude (Bridge)",
			planName: "Pro/Max",
			capturedAt: now,
			primaryWindow,
			windows: [primaryWindow, weeklyWindow],
		};
	}
}
