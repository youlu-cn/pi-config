import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export class GrokAdapter implements ProviderAdapter {
	readonly id = "grok";
	readonly displayName = "xAI Grok";
	readonly supportedProviders = ["xai", "grok"];

	isConfigured(ctx: ExtensionContext): boolean {
		const auth = loadAuthStorage();
		if (auth.xai || auth.grok) return true;
		return ctx.model?.provider === "xai" || ctx.model?.provider === "grok";
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		let token: string | undefined;

		// 1. 尝试从 Pi 运行时获取
		if (ctx?.modelRegistry?.getProviderAuth) {
			try {
				const res = await ctx.modelRegistry.getProviderAuth("xai");
				if (res?.auth?.apiKey) token = res.auth.apiKey;
				if (!token && res?.auth?.headers?.Authorization) {
					token = res.auth.headers.Authorization.replace(/^Bearer\s+/i, "");
				}
			} catch {}
		}

		// 2. 从 auth.json 读取
		if (!token) {
			const auth = loadAuthStorage();
			const entry = auth.xai || auth.grok || {};
			token = entry.access || entry.access_token || entry.token;
		}

		if (!token) {
			throw new Error("xAI Grok is not logged in. Please run /login xai.");
		}

		const headers = {
			Authorization: `Bearer ${token}`,
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-client-version": "0.1.0",
		};

		// 获取 userId
		const userRes = await fetch("https://cli-chat-proxy.grok.com/v1/user", {
			headers,
			signal,
		});

		if (userRes.status === 401) {
			throw new Error("xAI Grok session expired or unauthorized. Please re-run /login xai.");
		}
		if (!userRes.ok) {
			throw new Error(`xAI user endpoint returned status ${userRes.status}`);
		}

		const userData = (await userRes.json()) as any;
		const userId = userData?.userId;

		// 请求计费配额数据
		const billingHeaders = {
			...headers,
			...(userId ? { "x-userid": userId } : {}),
		};

		const billingRes = await fetch(
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			{ headers: billingHeaders, signal },
		);

		if (!billingRes.ok) {
			throw new Error(`xAI billing endpoint returned status ${billingRes.status}`);
		}

		const billingData = (await billingRes.json()) as any;
		const now = Date.now();
		const windows: QuotaWindow[] = [];

		// 解析配额信用点
		const creditsConfig =
			billingData?.billingConfig || billingData?.credits || billingData;

		if (creditsConfig) {
			// 周度或滚动窗口
			const usedCredits = typeof creditsConfig.usedCredits === "number" ? creditsConfig.usedCredits : 0;
			const totalCredits = typeof creditsConfig.totalCredits === "number" ? creditsConfig.totalCredits : 0;

			let remainingPercent = 100;
			if (totalCredits > 0) {
				const rem = Math.max(0, totalCredits - usedCredits);
				remainingPercent = Math.round((rem / totalCredits) * 100);
			}

			let resetsAt: number | undefined;
			if (creditsConfig.resetTime) {
				const parsed = Date.parse(creditsConfig.resetTime);
				if (!isNaN(parsed)) resetsAt = parsed;
			}

			windows.push(
				buildQuotaWindow({
					kind: "weekly",
					groupId: "xai",
					groupLabel: "xAI Grok Subscription",
					label: "Grok 1w",
					modelKeys: ["grok", "xai"],
					remainingPercent,
					windowMinutes: 10080,
					resetsAt,
				}),
			);
		}

		if (windows.length === 0) {
			throw new Error("No displayable quota windows returned for xAI Grok.");
		}

		return {
			providerId: "xai",
			displayName: "xAI Grok",
			planName: userData?.tier || "SuperGrok",
			capturedAt: now,
			primaryWindow: windows[0]!,
			windows,
		};
	}
}
