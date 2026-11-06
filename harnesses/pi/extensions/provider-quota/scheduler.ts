import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTimeoutSignal } from "./auth-helper.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { ProviderQuotaReport } from "./types.ts";

export const SUBSCRIPTION_USAGE_EVENT = "subscription-usage/status/v1";

interface CacheEntry {
	report: ProviderQuotaReport;
	expiresAt: number;
}

export class QuotaScheduler {
	private readonly cache: Map<string, CacheEntry> = new Map();
	private readonly cacheTtlMs: number;
	private pollTimer?: NodeJS.Timeout;
	private activeAbortController?: AbortController;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly registry: AdapterRegistry,
		options: { cacheTtlMs?: number } = {},
	) {
		this.cacheTtlMs = options.cacheTtlMs ?? 60_000; // 默认 60 秒缓存
	}

	/** Start background periodic polling */
	start(ctx: ExtensionContext, intervalMs = 120_000): void {
		this.stop();
		// 初始立即刷新一次当前模型
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

		// 检查缓存
		const now = Date.now();
		const cached = this.cache.get(adapter.id);
		if (cached && cached.expiresAt > now) {
			this.broadcast(cached.report);
			return cached.report;
		}

		// 超时控制 (5 秒)
		const { signal, cleanup } = createTimeoutSignal(5000);
		try {
			const report = await adapter.fetchQuota(ctx, signal);
			this.cache.set(adapter.id, {
				report,
				expiresAt: now + this.cacheTtlMs,
			});
			this.broadcast(report);
			return report;
		} catch (error) {
			// 静默降级，不阻断宿主运行
			return undefined;
		} finally {
			cleanup();
		}
	}

	/** Broadcast standard status event to session-ui statusline */
	private broadcast(report: ProviderQuotaReport): void {
		this.pi.events.emit(SUBSCRIPTION_USAGE_EVENT, {
			v: 1,
			status: "ready",
			providerId: report.providerId,
			capturedAt: report.capturedAt,
			displayMode: "remaining",
			windows: report.windows,
		});
	}
}
