import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTimeoutSignal } from "./auth-helper.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { ProviderQuotaReport, QuotaWindow } from "./types.ts";

export const SUBSCRIPTION_USAGE_EVENT = "subscription-usage/status/v1";

interface CacheEntry {
	report: ProviderQuotaReport;
	expiresAt: number;
}

/** Match best quota windows for the given model ID (returns all windows in matched group).
 * Returns an empty array when no group matches: a window that does not describe the
 * active model must never be shown as if it did. */
export function matchQuotaWindowsForModel(
	windows: QuotaWindow[],
	modelId?: string,
): QuotaWindow[] {
	if (!windows || windows.length === 0) return [];
	if (!modelId) return windows;

	const normalized = modelId.toLowerCase();
	let bestGroupId: string | undefined;
	let maxMatchLen = 0;

	for (const win of windows) {
		if (!win.modelKeys || win.modelKeys.length === 0) continue;
		for (const key of win.modelKeys) {
			const k = key.toLowerCase();
			if (normalized.includes(k) && k.length > maxMatchLen) {
				maxMatchLen = k.length;
				bestGroupId = win.groupId;
			}
		}
	}

	if (bestGroupId) {
		return windows.filter((w) => w.groupId === bestGroupId);
	}

	return [];
}

/** Match best single quota window for backward compatibility */
export function matchQuotaWindow(
	windows: QuotaWindow[],
	modelId?: string,
): QuotaWindow | undefined {
	return matchQuotaWindowsForModel(windows, modelId)[0];
}

export class QuotaScheduler {
	private readonly pi: ExtensionAPI;
	private readonly registry: AdapterRegistry;
	private readonly cache: Map<string, CacheEntry> = new Map();
	private readonly inFlight: Map<string, Promise<ProviderQuotaReport | undefined>> = new Map();
	private readonly cacheTtlMs: number;
	private pollTimer?: NodeJS.Timeout;
	private activeAbortController?: AbortController;

	constructor(
		pi: ExtensionAPI,
		registry: AdapterRegistry,
		options: { cacheTtlMs?: number } = {},
	) {
		this.pi = pi;
		this.registry = registry;
		this.cacheTtlMs = options.cacheTtlMs ?? 60_000; // Default 60-second TTL
	}

	/** Start background periodic polling */
	start(ctx: ExtensionContext, intervalMs = 120_000): void {
		this.stop();
		this.activeAbortController = new AbortController();
		// Initial immediate refresh for active model provider
		this.refreshActiveProvider(ctx);

		this.pollTimer = setInterval(() => {
			this.refreshActiveProvider(ctx);
		}, intervalMs);
	}

	/** Stop polling and abort any pending fetch */
	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.activeAbortController) {
			this.activeAbortController.abort();
			this.activeAbortController = undefined;
		}
		this.inFlight.clear();
	}

	/** Query quota for active model's provider and broadcast if changed (with singleflight deduplication) */
	async refreshActiveProvider(ctx: ExtensionContext): Promise<ProviderQuotaReport | undefined> {
		const currentProvider = ctx.model?.provider;
		if (!currentProvider) {
			this.broadcastUnavailable("none");
			return undefined;
		}

		const adapter = this.registry.findAdapterForProvider(currentProvider);
		if (!adapter || !adapter.isConfigured(ctx)) {
			// Unknown provider: clear the statusline instead of leaving the previous
			// provider's quota on screen.
			this.broadcastUnavailable(currentProvider);
			return undefined;
		}

		// 1. Check in-memory TTL cache
		const now = Date.now();
		const cached = this.cache.get(adapter.id);
		if (cached && cached.expiresAt > now) {
			this.broadcast(cached.report, ctx);
			return cached.report;
		}

		// 2. Singleflight deduplication: reuse pending request if already in flight
		const existingPromise = this.inFlight.get(adapter.id);
		if (existingPromise) {
			const report = await existingPromise;
			if (report) this.broadcast(report, ctx);
			return report;
		}

		// 3. Execute network fetch with 8-second timeout linked to scheduler lifecycle
		if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
			this.activeAbortController = new AbortController();
		}
		const { signal, cleanup } = createTimeoutSignal(8000, this.activeAbortController.signal);

		const fetchPromise = (async () => {
			try {
				const report = await adapter.fetchQuota(ctx, signal);
				this.cache.set(adapter.id, {
					report,
					expiresAt: Date.now() + this.cacheTtlMs,
				});
				this.broadcast(report, ctx);
				return report;
			} catch {
				// Silent fallback: do not interrupt agent execution. Keep the last known
				// good report for this adapter, but never keep showing a report that
				// belongs to a different provider.
				if (!this.cache.has(adapter.id)) {
					this.broadcastUnavailable(currentProvider);
				}
				return undefined;
			} finally {
				cleanup();
				this.inFlight.delete(adapter.id);
			}
		})();

		this.inFlight.set(adapter.id, fetchPromise);
		return fetchPromise;
	}

	/** Broadcast standard status event to session-ui statusline */
	private broadcast(report: ProviderQuotaReport, ctx?: ExtensionContext): void {
		let targetWindows = report.windows;
		const modelId = ctx?.model?.id;

		// Single-group providers (e.g. ChatGPT / Grok / Claude Bridge) apply to all
		// models served by that provider; multi-group providers (e.g. Antigravity)
		// match the specific model family group.
		const distinctGroups = new Set(report.windows.map((w) => w.groupId || ""));
		if (modelId && distinctGroups.size > 1) {
			targetWindows = matchQuotaWindowsForModel(report.windows, modelId);
		}

		if (targetWindows.length === 0) {
			// No window describes the active model; showing another group's numbers
			// would misattribute quota, so clear the display instead.
			this.broadcastUnavailable(report.providerId);
			return;
		}

		this.pi.events.emit(SUBSCRIPTION_USAGE_EVENT, {
			v: 1,
			status: "ready",
			providerId: report.providerId,
			capturedAt: report.capturedAt,
			displayMode: "remaining",
			windows: targetWindows,
		});
	}

	/** Emit a non-ready status so consumers drop the previously displayed quota. */
	private broadcastUnavailable(providerId: string): void {
		this.pi.events.emit(SUBSCRIPTION_USAGE_EVENT, {
			v: 1,
			status: "unavailable",
			providerId,
			capturedAt: Date.now(),
			windows: [],
		});
	}
}
