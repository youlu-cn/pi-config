import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage, resolveAntigravityToken } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow, QuotaWindowKind } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export const ANTIGRAVITY_GEMINI_MODELS = "gemini-models";
export const ANTIGRAVITY_ARGON_MODELS = "gemini-argon";
export const ANTIGRAVITY_3P_MODELS = "claude-and-gpt-models";

const ARGON_MODEL_KEYS = ["argon", "gemini-4-argon"];
const HYDROGEN_MODEL_KEYS = ["hydrogen", "gemini-4-hydrogen"];
const GEMINI_MODEL_KEYS = [
	...HYDROGEN_MODEL_KEYS, "gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini",
];

/** Pro has separate pools; Ultra tiers share the Gemini 4 pool. */
export function hasSharedGemini4Pool(assistData: any): boolean {
	const tier = assistData?.paidTier ?? assistData?.currentTier;
	return /ultra/i.test(`${tier?.id ?? ""} ${tier?.name ?? ""}`);
}

const ANTIGRAVITY_HOSTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];

// Catalog & quota-group visibility is gated on the full CLI User-Agent fingerprint.
// A short "antigravity/1.4.0" string hides Gemini Models and Gemini 4 Argon groups
// in retrieveUserQuotaSummary, while `cloudcode-pa` returns static 1.0 fractions.
const ANTIGRAVITY_USER_AGENT =
	process.env.ANTIGRAVITY_USER_AGENT?.trim() ||
	"antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

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
					Accept: "application/json",
					"User-Agent": ANTIGRAVITY_USER_AGENT,
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
	if (w.includes("week") || id.includes("week") || w === "1w" || w === "7d" || w === "168h") return "weekly";
	if (w.endsWith("h") || id.includes("h") || w.includes("hour")) return "hourly";
	if (w.includes("day") || id.includes("day") || w === "1d") return "daily";
	if (w.includes("roll")) return "rolling";
	return "quota";
}

function parseWindowMinutes(windowStr?: string): number | undefined {
	const w = String(windowStr || "").toLowerCase();
	if (/^\d+d$/.test(w)) return parseInt(w, 10) * 1440;
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
		const auth = loadAuthStorage();
		if (auth.antigravity || auth["google-antigravity"]) return true;
		if (ctx.model?.provider === "antigravity") return true;
		return false;
	}

	async fetchQuota(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<ProviderQuotaReport> {
		const cred = await resolveAntigravityToken(ctx);
		if (!cred?.token) {
			throw new Error("Antigravity is not logged in. Please run /login antigravity.");
		}
		const now = Date.now();

		const nextMidnight = new Date();
		nextMidnight.setUTCHours(24, 0, 0, 0);
		const defaultResetsAt = nextMidnight.getTime();

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
				{
					metadata: {
						ideType: "ANTIGRAVITY",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				},
				signal,
			),
		]);

		const sharedGemini4Pool = hasSharedGemini4Pool(assistData);
		let windows: QuotaWindow[] = [];
		if (Array.isArray(quotaData?.groups) && quotaData.groups.length > 0) {
			windows = buildAntigravityWindows(quotaData.groups, defaultResetsAt, sharedGemini4Pool);
		}

		// Free-tier accounts get 403 on retrieveUserQuotaSummary; fall back to
		// fetchAvailableModels on daily-cloudcode-pa where per-model quotaInfo is live.
		if (
			windows.length === 0 &&
			modelsData?.models &&
			typeof modelsData.models === "object"
		) {
			windows = buildAntigravityModelFallbackWindows(
				modelsData.models as Record<string, any>,
				defaultResetsAt,
				sharedGemini4Pool,
			);
		}

		if (windows.length === 0) {
			throw new Error("Antigravity quota endpoints returned no quota windows.");
		}

		const planName =
			assistData?.paidTier?.name || assistData?.currentTier?.name || undefined;

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
}

/** Map the raw `retrieveUserQuotaSummary` groups onto normalized quota windows. */
export function buildAntigravityWindows(
	groups: any[],
	defaultResetsAt: number,
	sharedGemini4Pool = false,
): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	const hasArgonGroup = groups.some((group) =>
		String(group?.displayName ?? "").toLowerCase().includes("argon"),
	);

	for (const group of groups) {
		const displayName = typeof group?.displayName === "string" ? group.displayName : "";
		const normName = displayName.toLowerCase();
		const buckets = Array.isArray(group?.buckets) ? group.buckets : [];

		const isArgon = normName.includes("argon");
		const is3p = normName.includes("claude") || normName.includes("gpt");
		const groupId = isArgon
			? ANTIGRAVITY_ARGON_MODELS
			: is3p
				? ANTIGRAVITY_3P_MODELS
				: ANTIGRAVITY_GEMINI_MODELS;
		const groupPrefix = sharedGemini4Pool && (isArgon || (!is3p && !hasArgonGroup))
			? "Gemini"
			: isArgon ? "Argon" : is3p ? "Claude" : normName.includes("hydrogen") ? "Hydrogen" : "Gemini";
		// Never match Argon by the broad `gemini-4` prefix: Hydrogen uses it too.
		const isSharedGroup = sharedGemini4Pool && !is3p && (isArgon || !hasArgonGroup);
		const modelKeys = isSharedGroup
			? [...ARGON_MODEL_KEYS, ...(isArgon ? HYDROGEN_MODEL_KEYS : GEMINI_MODEL_KEYS)]
			: isArgon
				? ARGON_MODEL_KEYS
				: is3p
					? ["claude", "gpt"]
					: GEMINI_MODEL_KEYS.filter((key) =>
						!(sharedGemini4Pool && hasArgonGroup && HYDROGEN_MODEL_KEYS.includes(key)),
					);

		const groupLabel = isSharedGroup
			? "Gemini 4 Argon / Hydrogen"
			: isArgon
				? "Gemini 4 Argon"
				: is3p
					? "Claude and GPT models"
					: "Gemini Models";

		for (const b of buckets) {
			// A bucket without a usable fraction carries no information: reporting it
			// as 100% remaining would fake an unused quota.
			if (typeof b?.remainingFraction !== "number" || !Number.isFinite(b.remainingFraction)) {
				continue;
			}
			const remainingPercent = Math.round(
				Math.max(0, Math.min(1, b.remainingFraction)) * 100,
			);

			let resetsAt = defaultResetsAt;
			if (b.resetTime) {
				const parsed = Date.parse(b.resetTime);
				if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
			}

			const kind = parseWindowKind(b.window, b.bucketId);
			const windowMinutes = parseWindowMinutes(b.window);

			// Multi-window groups keep the model name only on the shortest window
			// (usually 5h); later windows are just "1w" so the statusline doesn't
			// repeat "Gemini Gemini".
			let label = groupPrefix;
			if (b.window === "5h") {
				label = `${groupPrefix} 5h`;
			} else if (kind === "weekly") {
				label = buckets.length > 1 ? "1w" : `${groupPrefix} 1w`;
			} else if (buckets.length > 1 && b.displayName) {
				const shortName = String(b.displayName).replace(/Limit|Remaining/gi, "").trim();
				label = shortName.slice(0, 16) || groupPrefix;
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

/** Fallback window builder from `fetchAvailableModels` when `retrieveUserQuotaSummary` is unavailable (e.g. free tier). */
export function buildAntigravityModelFallbackWindows(
	models: Record<string, any>,
	defaultResetsAt: number,
	sharedGemini4Pool = false,
): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	const entries = Object.entries(models || {});
	const hasArgonModel = entries.some(([id, m]) =>
		/argon/i.test(`${id} ${m?.displayName ?? ""}`) &&
		typeof m?.quotaInfo?.remainingFraction === "number" &&
		Number.isFinite(m.quotaInfo.remainingFraction),
	);

	const addFromModel = (
		matchFn: (id: string, m: any) => boolean,
		options: {
			groupId: string;
			groupLabel: string;
			label: string;
			modelKeys: string[];
		},
	) => {
		const hit = entries.find(
			([id, m]) =>
				m &&
				typeof m === "object" &&
				typeof m.quotaInfo?.remainingFraction === "number" &&
				Number.isFinite(m.quotaInfo.remainingFraction) &&
				matchFn(id.toLowerCase(), m),
		);
		if (!hit) return;
		const qi = hit[1].quotaInfo;
		const remainingPercent = Math.round(
			Math.max(0, Math.min(1, qi.remainingFraction)) * 100,
		);
		let resetsAt = defaultResetsAt;
		if (qi.resetTime) {
			const parsed = Date.parse(qi.resetTime);
			if (!isNaN(parsed) && parsed > 0) resetsAt = parsed;
		}
		windows.push(
			buildQuotaWindow({
				kind: "weekly",
				groupId: options.groupId,
				groupLabel: options.groupLabel,
				label: options.label,
				modelKeys: options.modelKeys,
				remainingPercent,
				resetsAt,
			}),
		);
	};

	addFromModel(
		(id, m) =>
			(id.includes("gemini") || String(m.displayName || "").toLowerCase().includes("gemini")) &&
			!id.includes("argon") &&
			!String(m.displayName || "").toLowerCase().includes("argon") &&
			!(sharedGemini4Pool && hasArgonModel && /hydrogen/i.test(`${id} ${m.displayName || ""}`)),
		{
			groupId: ANTIGRAVITY_GEMINI_MODELS,
			groupLabel: "Gemini Models",
			label: "Gemini 1w",
			modelKeys: sharedGemini4Pool && !hasArgonModel
				? [...GEMINI_MODEL_KEYS, ...ARGON_MODEL_KEYS]
				: GEMINI_MODEL_KEYS.filter((key) =>
					!(sharedGemini4Pool && hasArgonModel && HYDROGEN_MODEL_KEYS.includes(key)),
				),
		},
	);

	addFromModel(
		(id, m) =>
			id.includes("argon") || String(m.displayName || "").toLowerCase().includes("argon"),
		{
			groupId: ANTIGRAVITY_ARGON_MODELS,
			groupLabel: sharedGemini4Pool ? "Gemini 4 Argon / Hydrogen" : "Gemini 4 Argon",
			label: sharedGemini4Pool ? "Gemini 1w" : "Argon 1w",
			modelKeys: sharedGemini4Pool ? [...ARGON_MODEL_KEYS, ...HYDROGEN_MODEL_KEYS] : ARGON_MODEL_KEYS,
		},
	);

	addFromModel(
		(id, m) =>
			id.includes("claude") ||
			id.includes("gpt") ||
			String(m.displayName || "").toLowerCase().includes("claude") ||
			String(m.displayName || "").toLowerCase().includes("gpt"),
		{
			groupId: ANTIGRAVITY_3P_MODELS,
			groupLabel: "Claude and GPT models",
			label: "Claude 1w",
			modelKeys: ["claude", "gpt"],
		},
	);

	return windows;
}
