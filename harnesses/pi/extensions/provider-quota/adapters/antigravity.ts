import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAntigravityToken } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow, QuotaWindowKind } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export const ANTIGRAVITY_GEMINI_MODELS = "gemini-models";
export const ANTIGRAVITY_ARGON_MODELS = "gemini-argon";
export const ANTIGRAVITY_3P_MODELS = "claude-and-gpt-models";

const ANTIGRAVITY_HOSTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.googleapis.com",
];

async function fetchAntigravityApi(
	path: string,
	token: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<any> {
	for (const host of ANTIGRAVITY_HOSTS) {
		try {
			const res = await fetch(`${host}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.4.0",
				},
				body: JSON.stringify(body),
				signal,
			});
			if (res.ok) {
				return await res.json();
			}
		} catch {
			// Fallback to next candidate endpoint
		}
	}
	return null;
}

function parseWindowKind(windowStr?: string, bucketId?: string): QuotaWindowKind {
	const w = String(windowStr || "").toLowerCase();
	const id = String(bucketId || "").toLowerCase();
	if (w.includes("month") || id.includes("month") || w === "1m") return "monthly";
	if (w.includes("week") || id.includes("week") || w === "1w") return "weekly";
	if (w.endsWith("h") || id.includes("h") || w.includes("hour")) return "hourly";
	if (w.includes("day") || id.includes("day") || w === "1d") return "daily";
	if (w.includes("roll")) return "rolling";
	return "quota";
}

function parseWindowMinutes(windowStr?: string): number | undefined {
	const w = String(windowStr || "").toLowerCase();
	if (w.endsWith("h")) return parseInt(w, 10) * 60;
	if (w.includes("week") || w === "1w") return 10080;
	if (w.includes("month") || w === "1m") return 43200;
	if (w.includes("day") || w === "1d") return 1440;
	return undefined;
}

export class AntigravityAdapter implements ProviderAdapter {
	readonly id = "antigravity";
	readonly displayName = "Google Antigravity";
	readonly supportedProviders = ["antigravity"];

	isConfigured(ctx: ExtensionContext): boolean {
		if (ctx.model?.provider === "antigravity") return true;
		return true;
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const cred = await resolveAntigravityToken();
		const now = Date.now();

		const nextMidnight = new Date();
		nextMidnight.setUTCHours(24, 0, 0, 0);
		const defaultResetsAt = nextMidnight.getTime();

		let windows: QuotaWindow[] = [];
		let planName: string | undefined;

		if (cred?.token) {
			try {
				const [quotaData, modelsData, assistData] = await Promise.all([
					fetchAntigravityApi("/v1internal:retrieveUserQuotaSummary", cred.token, {}, signal),
					fetchAntigravityApi(
						"/v1internal:fetchAvailableModels",
						cred.token,
						{ project: cred.projectId },
						signal,
					),
					fetchAntigravityApi(
						"/v1internal:loadCodeAssist",
						cred.token,
						{ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED" } },
						signal,
					),
				]);

				if (assistData) {
					planName =
						assistData.paidTier?.name ||
						assistData.currentTier?.name ||
						undefined;
				}

				if (Array.isArray(quotaData?.groups) && quotaData.groups.length > 0) {
					windows = this.parseAntigravityGroups(quotaData.groups, defaultResetsAt);
				}

				// If Gemini quota was not in retrieveUserQuotaSummary, extract from fetchAvailableModels
				if (
					!windows.some((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS) &&
					modelsData?.models
				) {
					const geminiModel = Object.values(modelsData.models as Record<string, any>).find(
						(m) =>
							m &&
							typeof m === "object" &&
							m.quotaInfo &&
							typeof m.displayName === "string" &&
							m.displayName.includes("Gemini"),
					);
					if (geminiModel?.quotaInfo) {
						const qi = geminiModel.quotaInfo;
						const frac =
							typeof qi.remainingFraction === "number" ? qi.remainingFraction : 1.0;
						const remainingPercent = Math.round(Math.max(0, Math.min(1, frac)) * 100);
						let resetsAt = defaultResetsAt;
						if (qi.resetTime) {
							const parsed = Date.parse(qi.resetTime);
							if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
						}
						windows.push(
							buildQuotaWindow({
								kind: "weekly",
								groupId: ANTIGRAVITY_GEMINI_MODELS,
								groupLabel: "Gemini Models",
								label: "Gemini",
								modelKeys: [
									"gemini-flash",
									"gemini-pro",
									"gemini-3",
									"gemini-2",
									"gemini",
								],
								remainingPercent,
								resetsAt,
							}),
						);
					}
				}

				// Check Argon models quota if not yet added
				if (
					!windows.some((w) => w.groupId === ANTIGRAVITY_ARGON_MODELS) &&
					modelsData?.models
				) {
					const argonModel = Object.values(modelsData.models as Record<string, any>).find(
						(m) =>
							m &&
							typeof m === "object" &&
							m.quotaInfo &&
							((m.displayName && String(m.displayName).toLowerCase().includes("argon")) ||
								(m.modelId && String(m.modelId).toLowerCase().includes("argon"))),
					);
					if (argonModel?.quotaInfo) {
						const qi = argonModel.quotaInfo;
						const frac =
							typeof qi.remainingFraction === "number" ? qi.remainingFraction : 1.0;
						const remainingPercent = Math.round(Math.max(0, Math.min(1, frac)) * 100);
						let resetsAt = defaultResetsAt;
						if (qi.resetTime) {
							const parsed = Date.parse(qi.resetTime);
							if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
						}
						windows.push(
							buildQuotaWindow({
								kind: "weekly",
								groupId: ANTIGRAVITY_ARGON_MODELS,
								groupLabel: "Gemini 4 Argon",
								label: "Argon",
								modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
								remainingPercent,
								resetsAt,
							}),
						);
					}
				}

				// If Argon still not separated, mirror Gemini quota so Argon model gets accurate remaining stats
				if (!windows.some((w) => w.groupId === ANTIGRAVITY_ARGON_MODELS)) {
					const geminiWin = windows.find((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS);
					windows.push(
						buildQuotaWindow({
							kind: geminiWin?.kind || "weekly",
							groupId: ANTIGRAVITY_ARGON_MODELS,
							groupLabel: "Gemini 4 Argon",
							label: "Argon",
							modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
							remainingPercent: geminiWin?.remainingPercent ?? 100,
							resetsAt: geminiWin?.resetsAt ?? defaultResetsAt,
						}),
					);
				}
			} catch {
				// Keep fallback if network error
			}
		}

		// Fallback when network or endpoints unavailable
		if (windows.length === 0) {
			windows = [
				buildQuotaWindow({
					kind: "weekly",
					groupId: ANTIGRAVITY_GEMINI_MODELS,
					groupLabel: "Gemini Models",
					label: "Gemini",
					modelKeys: ["gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini"],
					remainingPercent: 100,
					resetsAt: defaultResetsAt,
				}),
				buildQuotaWindow({
					kind: "weekly",
					groupId: ANTIGRAVITY_ARGON_MODELS,
					groupLabel: "Gemini 4 Argon",
					label: "Argon",
					modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
					remainingPercent: 100,
					resetsAt: defaultResetsAt,
				}),
				buildQuotaWindow({
					kind: "hourly",
					groupId: ANTIGRAVITY_3P_MODELS,
					groupLabel: "Claude and GPT models",
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
			accountEmail: cred?.email,
			planName: planName || "Google AI Pro",
			capturedAt: now,
			primaryWindow: windows[0]!,
			windows,
		};
	}

	private parseAntigravityGroups(groups: any[], defaultResetsAt: number): QuotaWindow[] {
		const windows: QuotaWindow[] = [];

		for (const group of groups) {
			const displayName = typeof group.displayName === "string" ? group.displayName : "";
			const normName = displayName.toLowerCase();
			const buckets = Array.isArray(group.buckets) ? group.buckets : [];

			const isArgon = normName.includes("argon");
			const is3p = normName.includes("claude") || normName.includes("gpt");
			const groupId = isArgon
				? ANTIGRAVITY_ARGON_MODELS
				: is3p
					? ANTIGRAVITY_3P_MODELS
					: ANTIGRAVITY_GEMINI_MODELS;
			const groupPrefix = isArgon ? "Argon" : is3p ? "Claude" : "Gemini";
			const modelKeys = isArgon
				? ["argon", "gemini-4-argon", "gemini-4"]
				: is3p
					? ["claude", "gpt"]
					: ["gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini"];

			const groupLabel = isArgon
				? "Gemini 4 Argon"
				: is3p
					? "Claude and GPT models"
					: "Gemini Models";

			for (const b of buckets) {
				const remainingFraction =
					typeof b.remainingFraction === "number" ? b.remainingFraction : 1.0;
				const remainingPercent = Math.round(
					Math.max(0, Math.min(1, remainingFraction)) * 100,
				);

				let resetsAt = defaultResetsAt;
				if (b.resetTime) {
					const parsed = Date.parse(b.resetTime);
					if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
				}

				const kind = parseWindowKind(b.window, b.bucketId);
				const windowMinutes = parseWindowMinutes(b.window);

				let label = groupPrefix;
				if (b.window === "5h") {
					label = `${groupPrefix} 5h`;
				} else if (b.window === "weekly" || String(b.bucketId).includes("weekly")) {
					label = `${groupPrefix} 1w`;
				} else if (buckets.length > 1 && b.displayName) {
					const shortName = String(b.displayName).replace(/Limit|Remaining/gi, "").trim();
					label = `${groupPrefix} ${shortName}`.trim().slice(0, 16);
				}

				windows.push(
					buildQuotaWindow({
						kind,
						groupId,
						groupLabel,
						label: label.slice(0, 16),
						modelKeys,
						remainingPercent,
						windowMinutes,
						resetsAt,
					}),
				);
			}
		}

		return windows;
	}
}
