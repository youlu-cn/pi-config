import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport } from "../types.ts";

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

		// Anthropic official API key is pay-as-you-go; no polling subscription quota endpoint is provided.
		if (!isBridge) {
			throw new Error(
				"Anthropic API key is pay-as-you-go and does not have a subscription quota endpoint.",
			);
		}

		// No bridge quota source is integrated yet; never invent remaining usage or resets.
		throw new Error("Claude Code Bridge quota information is unavailable: no usage data source is configured.");
	}
}
