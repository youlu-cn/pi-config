import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthStorage, resolveAntigravityToken } from "../auth-helper.ts";
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow, QuotaWindowKind } from "../types.ts";
import { buildQuotaWindow } from "./base.ts";

export const ANTIGRAVITY_GEMINI_MODELS = "gemini-models";
export const ANTIGRAVITY_3P_MODELS = "claude-and-gpt-models";

const GEMINI_MODEL_KEYS = ["gemini", "argon", "carbon", "hydrogen"];
const THIRD_PARTY_MODEL_KEYS = ["claude", "gpt"];

const ANTIGRAVITY_HOSTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];

// Catalog & quota-group visibility is gated on the full CLI User-Agent fingerprint.
// Keep in sync with @specode/pi-antigravity (agy CLI 1.5.9). A short UA string
// hides quota groups in retrieveUserQuotaSummary,
// while `cloudcode-pa` returns static 1.0 fractions.
const ANTIGRAVITY_CLI_VERSION = "1.5.9";
const ANTIGRAVITY_CLI_BUILD = "1021519450";
const ANTIGRAVITY_OS_TYPE =
	process.platform === "win32" ? "windows" : process.platform;
const ANTIGRAVITY_ARCH =
	process.arch === "x64" ? "amd64" : process.arch;
const ANTIGRAVITY_USER_AGENT =
	process.env.ANTIGRAVITY_USER_AGENT?.trim() ||
	`antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=${ANTIGRAVITY_OS_TYPE}; arch=${ANTIGRAVITY_ARCH}; cl=${ANTIGRAVITY_CLI_BUILD}; auth_method=consumer)`;

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

		let windows: QuotaWindow[] = [];
		if (Array.isArray(quotaData?.groups) && quotaData.groups.length > 0) {
			windows = buildAntigravityWindows(quotaData.groups, defaultResetsAt);
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
): QuotaWindow[] {
	const windows: QuotaWindow[] = [];

	for (const group of groups) {
		const displayName = typeof group?.displayName === "string" ? group.displayName : "";
		const normName = displayName.toLowerCase();
		// Ignore the obsolete standalone group rather than duplicate Gemini's weekly window.
		if (/^(?:gemini\s+\d+\s+)?argon(?:\s+models)?$/.test(normName.trim())) continue;
		const buckets = Array.isArray(group?.buckets) ? group.buckets : [];

		const is3p = normName.includes("claude") || normName.includes("gpt");
		const groupId = is3p ? ANTIGRAVITY_3P_MODELS : ANTIGRAVITY_GEMINI_MODELS;
		const groupPrefix = is3p ? "Claude" : "Gemini";
		const groupLabel = is3p ? "Claude and GPT models" : "Gemini Models";
		const modelKeys = is3p ? THIRD_PARTY_MODEL_KEYS : GEMINI_MODEL_KEYS;

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
): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	const entries = Object.entries(models || {});

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
		(id, m) => GEMINI_MODEL_KEYS.some((key) =>
			id.includes(key) || String(m.displayName || "").toLowerCase().includes(key),
		),
		{
			groupId: ANTIGRAVITY_GEMINI_MODELS,
			groupLabel: "Gemini Models",
			label: "Gemini 1w",
			modelKeys: GEMINI_MODEL_KEYS,
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
			modelKeys: THIRD_PARTY_MODEL_KEYS,
		},
	);

	return windows;
}
