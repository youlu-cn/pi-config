import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTimeoutSignal } from "./auth-helper.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { ProviderQuotaReport, QuotaWindow } from "./types.ts";

export const SUBSCRIPTION_USAGE_EVENT = "subscription-usage/status/v1";

interface CacheEntry {
	report: ProviderQuotaReport;
	expiresAt: number;
}

/** Match best quota windows for the given model ID (returns all windows in matched group) */
export function matchQuotaWindowsForModel(
	windows: QuotaWindow[],
	modelId?: string,
): QuotaWindow[] {
	if (!windows || windows.length === 0) return [];
	if (!modelId || windows.length === 1) return windows;

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
		const groupWindows = windows.filter((w) => w.groupId === bestGroupId);
		if (groupWindows.length > 0) return groupWindows;
	}

	return [windows[0]!];
}

/** Match best single quota window for backward compatibility */
export function matchQuotaWindow(
	windows: QuotaWindow[],
	modelId?: string,
): QuotaWindow | undefined {
	const matched = matchQuotaWindowsForModel(windows, modelId);
	return matched[0] ?? windows[0];
}

export class QuotaScheduler {
	private readonly pi: ExtensionAPI;
	private readonly registry: AdapterRegistry;
	private readonly cache: Map<string, CacheEntry> = new Map();
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
	}

	/** Query quota for active model's provider and broadcast if changed */
	async refreshActiveProvider(ctx: ExtensionContext): Promise<ProviderQuotaReport | undefined> {
		const currentProvider = ctx.model?.provider;
		if (!currentProvider) return undefined;

		const adapter = this.registry.findAdapterForProvider(currentProvider);
		if (!adapter || !adapter.isConfigured(ctx)) {
			return undefined;
		}

		// Check in-memory cache
		const now = Date.now();
		const cached = this.cache.get(adapter.id);
		if (cached && cached.expiresAt > now) {
			this.broadcast(cached.report, ctx);
			return cached.report;
		}

		// Timeout control (8 seconds)
		const { signal, cleanup } = createTimeoutSignal(8000);
		try {
			const report = await adapter.fetchQuota(ctx, signal);
			this.cache.set(adapter.id, {
				report,
				expiresAt: now + this.cacheTtlMs,
			});
			this.broadcast(report, ctx);
			return report;
		} catch (error) {
			// Silent fallback: do not interrupt agent execution
			return undefined;
		} finally {
			cleanup();
		}
	}

	/** Broadcast standard status event to session-ui statusline */
	private broadcast(report: ProviderQuotaReport, ctx?: ExtensionContext): void {
		let targetWindows = report.windows;
		const modelId = ctx?.model?.id;

		if (modelId && report.windows.length > 1) {
			const matched = matchQuotaWindowsForModel(report.windows, modelId);
			if (matched.length > 0) {
				targetWindows = matched;
			}
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
}
