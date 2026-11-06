import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export const ANTIGRAVITY_GEMINI_MODELS = "gemini-models";
export const ANTIGRAVITY_ARGON_MODELS = "gemini-argon";
export const ANTIGRAVITY_3P_MODELS = "claude-and-gpt-models";

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

		const now = Date.now();
		const nextMidnight = new Date();
		nextMidnight.setUTCHours(24, 0, 0, 0);
		const defaultResetsAt = nextMidnight.getTime();

		let windows: QuotaWindow[] = [];

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
					const data = (await res.json()) as any;
					if (Array.isArray(data?.groups) && data.groups.length > 0) {
						windows = this.parseAntigravityGroups(data.groups, defaultResetsAt);
					}
				}
			} catch {
				// 网络或解析失败时使用默认三组窗口降级
			}
		}

		// 默认保底三组配额窗口（Gemini、Gemini 4 Argon、Claude & GPT）
		if (windows.length === 0) {
			windows = [
				buildQuotaWindow({
					kind: "daily",
					groupId: ANTIGRAVITY_GEMINI_MODELS,
					label: "Gemini",
					modelKeys: ["gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini"],
					remainingPercent: 100,
					resetsAt: defaultResetsAt,
				}),
				buildQuotaWindow({
					kind: "daily",
					groupId: ANTIGRAVITY_ARGON_MODELS,
					label: "Argon",
					modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
					remainingPercent: 100,
					resetsAt: defaultResetsAt,
				}),
				buildQuotaWindow({
					kind: "daily",
					groupId: ANTIGRAVITY_3P_MODELS,
					label: "Claude/GPT",
					modelKeys: ["claude", "gpt"],
					remainingPercent: 100,
					resetsAt: defaultResetsAt,
				}),
			];
		}

		return {
			providerId: "antigravity",
			displayName: "Google Antigravity",
			accountEmail: entry.email,
			capturedAt: now,
			primaryWindow: windows[0]!,
			windows,
		};
	}

	private parseAntigravityGroups(groups: any[], defaultResetsAt: number): QuotaWindow[] {
		const windows: QuotaWindow[] = [];

		for (const group of groups) {
			const displayName = typeof group.displayName === "string" ? group.displayName : "";
			const buckets = Array.isArray(group.buckets) ? group.buckets : [];

			for (const b of buckets) {
				const bucketId = String(b.bucketId || "").toLowerCase();
				const remainingFraction = typeof b.remainingFraction === "number" ? b.remainingFraction : 1.0;
				const remainingPercent = Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100);

				let resetsAt = defaultResetsAt;
				if (b.resetTime) {
					const parsed = Date.parse(b.resetTime);
					if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
				}

				if (bucketId.includes("argon") || displayName.toLowerCase().includes("argon")) {
					windows.push(
						buildQuotaWindow({
							kind: "daily",
							groupId: ANTIGRAVITY_ARGON_MODELS,
							label: "Argon",
							modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
							remainingPercent,
							resetsAt,
						}),
					);
				} else if (
					bucketId.includes("3p") ||
					bucketId.includes("claude") ||
					bucketId.includes("gpt") ||
					displayName.toLowerCase().includes("claude") ||
					displayName.toLowerCase().includes("gpt")
				) {
					windows.push(
						buildQuotaWindow({
							kind: "daily",
							groupId: ANTIGRAVITY_3P_MODELS,
							label: "Claude/GPT",
							modelKeys: ["claude", "gpt"],
							remainingPercent,
							resetsAt,
						}),
					);
				} else {
					windows.push(
						buildQuotaWindow({
							kind: "daily",
							groupId: ANTIGRAVITY_GEMINI_MODELS,
							label: "Gemini",
							modelKeys: ["gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini"],
							remainingPercent,
							resetsAt,
						}),
					);
				}
			}
		}

		return windows;
	}
}
