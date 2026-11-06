import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type QuotaWindowKind = "hourly" | "daily" | "weekly" | "monthly" | "rolling";

export interface QuotaWindow {
	kind: QuotaWindowKind;
	label: string;
	remainingPercent: number; // 0..100
	usedPercent?: number;
	displayPercent?: number;
	windowMinutes?: number;
	resetsAt?: number; // UTC timestamp in ms
	resetCountdown?: string;
	used?: number;
	limit?: number;
}

export interface ProviderQuotaReport {
	providerId: string;
	displayName: string;
	accountEmail?: string;
	planName?: string;
	capturedAt: number;
	windows: QuotaWindow[];
	primaryWindow: QuotaWindow;
}

export interface ResolvedAuth {
	provider: string;
	apiKey?: string;
	oauthToken?: string;
	accountEmail?: string;
	headers: Record<string, string>;
	extra?: Record<string, unknown>;
}

export interface ProviderAdapter {
	/** Unique identifier of the adapter, e.g. "antigravity", "gpt", "claude", "grok" */
	readonly id: string;
	/** Human-readable display name */
	readonly displayName: string;
	/** Provider IDs matched in Pi configuration (e.g. ["antigravity"], ["openai", "openai-codex"]) */
	readonly supportedProviders: string[];

	/** Check if this adapter has valid credentials or can execute in the current context */
	isConfigured(ctx: ExtensionContext): boolean;

	/** Query quota report from provider endpoint */
	fetchQuota(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderQuotaReport>;
}
