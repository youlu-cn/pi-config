import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

function extractEmailFromJwt(token?: string): string | undefined {
	if (!token || typeof token !== "string") return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/profile"]?.email || payload?.email;
	} catch {
		return undefined;
	}
}

export class GptAdapter implements ProviderAdapter {
	readonly id = "gpt";
	readonly displayName = "OpenAI / GPT";
	readonly supportedProviders = ["openai", "openai-codex"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth["openai-codex"] || auth.openai) return true;
		return (
			ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex"
		);
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		let token: string | undefined;

		// 1. Try resolving credentials from Pi runtime
		if (ctx?.modelRegistry?.getProviderAuth) {
			try {
				const res = await ctx.modelRegistry.getProviderAuth("openai-codex");
				if (res?.auth?.apiKey) token = res.auth.apiKey;
				if (!token && res?.auth?.headers?.Authorization) {
					token = res.auth.headers.Authorization.replace(/^Bearer\s+/i, "");
				}
			} catch {}
		}

		// 2. Fall back to persisted auth.json
		if (!token) {
			const auth = loadAuthStorage();
			const entry = auth["openai-codex"] || auth.openai || {};
			token = entry.access_token || entry.token || entry.access;
		}

		if (!token || typeof token !== "string" || !token.startsWith("eyJ")) {
			throw new Error(
				"OpenAI Codex subscription not configured. Run /login openai-codex to enable quota tracking.",
			);
		}

		const now = Date.now();
		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": "pi-provider-quota/1.0.0",
			},
			signal,
		});

		if (!res.ok) {
			throw new Error(`ChatGPT usage endpoint returned status ${res.status}`);
		}

		const data = (await res.json()) as any;
		const rateLimit = data?.rate_limit || {};
		const windows: QuotaWindow[] = [];

		// Primary window (typically 5-hour rolling window)
		if (rateLimit.primary_window) {
			const pw = rateLimit.primary_window;
			const usedPercent = typeof pw.used_percent === "number" ? pw.used_percent : 0;
			const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
			const resetsAt = typeof pw.reset_at === "number" ? pw.reset_at * 1000 : undefined;
			const windowMinutes =
				typeof pw.limit_window_seconds === "number"
					? Math.round(pw.limit_window_seconds / 60)
					: 300;

			windows.push(
				buildQuotaWindow({
					kind: "rolling",
					groupId: "openai-codex",
					groupLabel: "ChatGPT Subscription",
					label: "GPT 5h",
					modelKeys: ["gpt", "openai", "codex"],
					remainingPercent,
					windowMinutes,
					resetsAt,
				}),
			);
		}

		// Secondary window (typically weekly quota)
		if (rateLimit.secondary_window) {
			const sw = rateLimit.secondary_window;
			const usedPercent = typeof sw.used_percent === "number" ? sw.used_percent : 0;
			const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
			const resetsAt = typeof sw.reset_at === "number" ? sw.reset_at * 1000 : undefined;
			const windowMinutes =
				typeof sw.limit_window_seconds === "number"
					? Math.round(sw.limit_window_seconds / 60)
					: 10080;

			windows.push(
				buildQuotaWindow({
					kind: "weekly",
					groupId: "openai-codex",
					groupLabel: "ChatGPT Subscription",
					label: "GPT 1w",
					modelKeys: ["gpt", "openai", "codex"],
					remainingPercent,
					windowMinutes,
					resetsAt,
				}),
			);
		}

		if (windows.length === 0) {
			throw new Error("No rate limit windows returned by ChatGPT usage endpoint.");
		}

		const planName = data?.plan_type ? String(data.plan_type).toUpperCase() : "Plus/Pro";
		const email = extractEmailFromJwt(token);

		return {
			providerId: "openai-codex",
			displayName: "OpenAI / GPT",
			accountEmail: email,
			planName,
			capturedAt: now,
			primaryWindow: windows[0]!,
			windows,
		};
	}
}
