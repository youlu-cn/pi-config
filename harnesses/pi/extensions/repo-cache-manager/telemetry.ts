import { createHash } from "node:crypto";

/** Approximate tokens from character count (≈4 chars/token). */
export function estimateTokensFromChars(chars: number): number {
	if (chars <= 0) return 0;
	return Math.ceil(chars / 4);
}

/** Extract plain text from an agent/tool message content field. */
export function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: string; text?: string };
			if (typeof p.text === "string") parts.push(p.text);
		}
		return parts.join("");
	}
	if (content == null) return "";
	try {
		return JSON.stringify(content);
	} catch {
		return String(content);
	}
}

export function estimateMessageTokens(msg: { content?: unknown }): number {
	return estimateTokensFromChars(extractMessageText(msg.content).length);
}

export function estimateMessagesTokens(messages: readonly { content?: unknown }[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateMessageTokens(msg);
	}
	return total;
}

/** Short stable hash (8 hex chars) for fingerprint comparisons. */
export function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function hashMessage(msg: { role?: string; content?: unknown; toolCallId?: string; toolName?: string }): string {
	const role = typeof msg.role === "string" ? msg.role : "?";
	const toolMeta =
		msg.toolCallId || msg.toolName ? `|${msg.toolName ?? ""}|${msg.toolCallId ?? ""}` : "";
	return shortHash(`${role}${toolMeta}|${extractMessageText(msg.content)}`);
}

/** Hash the first N-1 messages (stable prefix). Empty when fewer than 2 messages. */
export function hashMessagePrefix(messages: readonly { role?: string; content?: unknown; toolCallId?: string; toolName?: string }[]): string[] {
	if (messages.length < 2) return [];
	const prefix = messages.slice(0, -1);
	return prefix.map((m) => hashMessage(m));
}

export type PrefixLockResult =
	| { status: "first"; label: string }
	| { status: "locked"; label: string }
	| { status: "busted"; label: string; bustIndex: number };

/** Compare current prefix hashes against the previous turn. */
export function comparePrefixLocks(previous: string[] | null, current: string[]): PrefixLockResult {
	if (!previous || previous.length === 0) {
		return { status: "first", label: "🆕 FIRST_TURN" };
	}
	const limit = Math.min(previous.length, current.length);
	for (let i = 0; i < limit; i++) {
		if (previous[i] !== current[i]) {
			return { status: "busted", label: `💥 BUSTED at msg[${i}]`, bustIndex: i };
		}
	}
	if (previous.length !== current.length) {
		// Growing prefix is expected when new turns append; only earlier hashes matter.
		// If current is shorter, something was dropped → bust at first missing index.
		if (current.length < previous.length) {
			return {
				status: "busted",
				label: `💥 BUSTED at msg[${current.length}]`,
				bustIndex: current.length,
			};
		}
	}
	return { status: "locked", label: "🔒 LOCKED" };
}

export interface CloudUsageSnapshot {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning?: number;
}

export function extractCloudUsage(usage: unknown): CloudUsageSnapshot | null {
	if (!usage || typeof usage !== "object") return null;
	const u = usage as Record<string, unknown>;
	const input = typeof u.input === "number" ? u.input : 0;
	const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
	const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
	const output = typeof u.output === "number" ? u.output : 0;
	const reasoning = typeof u.reasoning === "number" ? u.reasoning : undefined;
	return { input, cacheRead, cacheWrite, output, reasoning };
}

/** cloudCacheHitRate = cacheRead / (input + cacheRead). */
export function cloudCacheHitRate(usage: CloudUsageSnapshot): number | null {
	const denom = usage.input + usage.cacheRead;
	if (denom <= 0) return null;
	return usage.cacheRead / denom;
}

export interface ThinkingTax {
	visibleChars: number;
	visibleEstTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	thinkingRatio: number | null;
	source: "provider_reasoning" | "estimated";
}

/**
 * Prefer provider-reported reasoning tokens; otherwise estimate hidden thinking
 * as max(0, output − visibleChars/3.5).
 */
export function estimateThinkingTax(outputTokens: number, visibleChars: number, reasoning?: number): ThinkingTax {
	const visibleEstTokens = visibleChars > 0 ? Math.ceil(visibleChars / 3.5) : 0;
	if (typeof reasoning === "number") {
		const thinkingTokens = Math.max(0, reasoning);
		const thinkingRatio = outputTokens > 0 ? thinkingTokens / outputTokens : null;
		return {
			visibleChars,
			visibleEstTokens,
			outputTokens,
			thinkingTokens,
			thinkingRatio,
			source: "provider_reasoning",
		};
	}
	const thinkingTokens = Math.max(0, outputTokens - visibleEstTokens);
	const thinkingRatio = outputTokens > 0 ? thinkingTokens / outputTokens : null;
	return {
		visibleChars,
		visibleEstTokens,
		outputTokens,
		thinkingTokens,
		thinkingRatio,
		source: "estimated",
	};
}

export type RepoCacheInjectStatus = "injected" | "unindexed" | "deferred" | "none";

export interface InjectionSnapshot {
	repoCacheStatus: RepoCacheInjectStatus;
	repoCacheInjectedTokens: number;
	sysPromptHash: string;
	sysPromptMutated: boolean;
	sysPromptLabel: string;
}

export interface DehydrationSnapshot {
	rawEstTokens: number;
	sentEstTokens: number;
	omittedTools: number;
	omittedSavedTokens: number;
	omittedSavedRatio: number | null;
}

export interface TimingSnapshot {
	ttftMs: number | null;
	totalDurationMs: number | null;
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
}

export interface CacheAuditCard {
	modelId: string;
	injection: InjectionSnapshot;
	prefix: PrefixLockResult;
	dehydration: DehydrationSnapshot;
	cloud: CloudUsageSnapshot | null;
	cloudCacheHitRate: number | null;
	prevCloudCacheHitRate: number | null;
	thinking: ThinkingTax | null;
	timing: TimingSnapshot;
	triggers: AuditTrigger[];
	timestamp: number;
}

export type AuditTrigger =
	| "heavy_model"
	| "local_dehydration"
	| "cache_bust";

export interface TelemetryConfig {
	enabled: boolean;
	/** Case-insensitive substring / regex source matched against provider/modelId. */
	heavyModelPattern: string;
	/** Notify when omittedSavedRatio >= this (0–1). Default 0.1 (10%). */
	dehydrationNotifyRatio: number;
	/** Minimum omitted tool messages before dehydration trigger. */
	dehydrationMinOmittedTools: number;
	/** Cloud hit-rate floor; drop from >= floor to below → cache_bust. Default 0.5. */
	cacheBustHitRateFloor: number;
	/** Always show audit card every turn (default true; false = trigger-only). */
	alwaysShow: boolean;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
	enabled: true,
	heavyModelPattern: "argon|carbon|astra|fable",
	dehydrationNotifyRatio: 0.1,
	dehydrationMinOmittedTools: 1,
	cacheBustHitRateFloor: 0.5,
	alwaysShow: true,
};

export function isHeavyModel(modelId: string, pattern: string): boolean {
	if (!modelId) return false;
	try {
		return new RegExp(pattern, "i").test(modelId);
	} catch {
		return modelId.toLowerCase().includes(pattern.toLowerCase());
	}
}

export function evaluateAuditTriggers(
	card: Omit<CacheAuditCard, "triggers">,
	cfg: TelemetryConfig,
): AuditTrigger[] {
	const triggers: AuditTrigger[] = [];
	if (isHeavyModel(card.modelId, cfg.heavyModelPattern)) {
		triggers.push("heavy_model");
	}
	const ratio = card.dehydration.omittedSavedRatio ?? 0;
	if (
		card.dehydration.omittedTools >= cfg.dehydrationMinOmittedTools &&
		ratio >= cfg.dehydrationNotifyRatio
	) {
		triggers.push("local_dehydration");
	}
	const floor = cfg.cacheBustHitRateFloor;
	const prev = card.prevCloudCacheHitRate;
	const curr = card.cloudCacheHitRate;
	if (prev != null && curr != null && prev >= floor && curr < floor) {
		triggers.push("cache_bust");
	}
	return triggers;
}

export function shouldShowAuditCard(triggers: AuditTrigger[], cfg: TelemetryConfig): boolean {
	if (!cfg.enabled) return false;
	if (cfg.alwaysShow) return true;
	return triggers.length > 0;
}

function pct(n: number | null | undefined, digits = 0): string {
	if (n == null || Number.isNaN(n)) return "n/a";
	return `${(n * 100).toFixed(digits)}%`;
}

function ms(n: number | null | undefined): string {
	if (n == null || Number.isNaN(n)) return "n/a";
	return `${Math.round(n)}ms`;
}

/** Notes when local/cloud cache was unused or busted this turn. */
export function collectCacheMissNotes(card: CacheAuditCard): string[] {
	const notes: string[] = [];
	const inj = card.injection;

	if (inj.repoCacheStatus === "unindexed") {
		notes.push("⚠️ repo cache unused — workspace unindexed; call `scout`");
	} else if (inj.repoCacheStatus === "deferred") {
		notes.push("ℹ️ repo cache deferred — light model; no summary tax this turn");
	} else if (inj.repoCacheStatus === "none") {
		notes.push("⚠️ repo cache unused — no scan-cache section injected");
	}

	if (inj.sysPromptMutated) {
		notes.push("⚠️ system prompt mutated — cloud prefix cache may miss");
	}

	if (card.prefix.status === "busted") {
		notes.push(`⚠️ history prefix busted (${card.prefix.label}) — cloud KV likely cold`);
	}

	if (card.cloud) {
		const c = card.cloud;
		if (c.cacheRead === 0 && c.cacheWrite === 0 && c.input > 0) {
			notes.push("⚠️ cloud cache unused — cacheRead=0 / cacheWrite=0");
		} else if (c.cacheRead === 0 && c.cacheWrite > 0) {
			notes.push("ℹ️ cloud cache write-only this turn (warming; cacheRead=0)");
		} else if (card.cloudCacheHitRate != null && card.cloudCacheHitRate < 0.5) {
			notes.push(`⚠️ cloud cache hit rate low (${pct(card.cloudCacheHitRate, 1)})`);
		}
	} else {
		notes.push("ℹ️ cloud usage not reported — cannot verify API cache hit");
	}

	if (card.dehydration.omittedTools === 0) {
		notes.push("ℹ️ local dehydration unused this turn (same-model / no bulky tools)");
	}

	return notes;
}

/** Plain-text audit card for notify / logs (no ANSI). */
export function formatAuditCardText(card: CacheAuditCard): string {
	const lines: string[] = [];
	lines.push("═══ Cache Audit ═══");
	lines.push(`model: ${card.modelId || "unknown"}`);
	if (card.triggers.length > 0) {
		lines.push(`triggers: ${card.triggers.join(", ")}`);
	}

	const inj = card.injection;
	const repoLabel =
		inj.repoCacheStatus === "injected"
			? `✅ injected (~${inj.repoCacheInjectedTokens} tok)`
			: inj.repoCacheStatus === "unindexed"
				? "⚠️ unindexed (unused)"
				: inj.repoCacheStatus === "deferred"
					? "⏸️ deferred (light model, 0 tok tax)"
					: "— none (unused)";
	lines.push(`1. Prefix & Injection`);
	lines.push(`   repoCache: ${repoLabel}`);
	lines.push(`   sysPrompt: ${inj.sysPromptHash} ${inj.sysPromptLabel}`);
	lines.push(`   prefix:    ${card.prefix.label}`);

	const d = card.dehydration;
	const savedPct = d.omittedSavedRatio != null ? pct(d.omittedSavedRatio) : "0%";
	lines.push(`2. Local Dehydration`);
	lines.push(`   tokens: ${d.rawEstTokens} → ${d.sentEstTokens} (omit ${d.omittedTools} tools, −${savedPct})`);

	lines.push(`3. Cloud Usage`);
	if (card.cloud) {
		const c = card.cloud;
		lines.push(
			`   in=${c.input} cacheRead=${c.cacheRead} cacheWrite=${c.cacheWrite} out=${c.output}`,
		);
		lines.push(`   cloudCacheHitRate: ${pct(card.cloudCacheHitRate, 1)}`);
	} else {
		lines.push(`   (no usage reported)`);
	}

	lines.push(`4. Thinking Tax`);
	if (card.thinking) {
		const t = card.thinking;
		lines.push(
			`   thinking≈${t.thinkingTokens} / out=${t.outputTokens} (${pct(t.thinkingRatio, 0)}, ${t.source})`,
		);
	} else {
		lines.push(`   (n/a)`);
	}

	const tm = card.timing;
	lines.push(`5. Latency & Window`);
	lines.push(`   ttft=${ms(tm.ttftMs)} total=${ms(tm.totalDurationMs)}`);
	const win =
		tm.contextPercent != null
			? `${tm.contextPercent.toFixed(1)}%` +
				(tm.contextTokens != null && tm.contextWindow != null
					? ` (${tm.contextTokens}/${tm.contextWindow})`
					: "")
			: "n/a";
	lines.push(`   context: ${win}`);

	const notes = collectCacheMissNotes(card);
	if (notes.length > 0) {
		lines.push(`notes:`);
		for (const note of notes) {
			lines.push(`   ${note}`);
		}
	}

	lines.push("═══════════════════");
	return lines.join("\n");
}

/** Compact single-line summary for status bar. */
export function formatAuditStatusLine(card: CacheAuditCard): string {
	const hit = card.cloudCacheHitRate != null ? pct(card.cloudCacheHitRate, 0) : "?";
	const prefix = card.prefix.status === "locked" ? "🔒" : card.prefix.status === "busted" ? "💥" : "🆕";
	const dehyd =
		card.dehydration.omittedTools > 0
			? ` −${card.dehydration.omittedTools}tool`
			: "";
	return `📡 Cache ${prefix} hit=${hit}${dehyd}`;
}

/**
 * Mutable collector spanning one user turn (may cover multiple provider calls).
 */
export class TurnTelemetryCollector {
	modelId = "";
	injection: InjectionSnapshot | null = null;
	prefix: PrefixLockResult | null = null;
	dehydration: DehydrationSnapshot | null = null;
	cloud: CloudUsageSnapshot | null = null;
	thinking: ThinkingTax | null = null;
	timing: TimingSnapshot = {
		ttftMs: null,
		totalDurationMs: null,
		contextPercent: null,
		contextTokens: null,
		contextWindow: null,
	};

	requestStartedAt: number | null = null;
	firstTokenAt: number | null = null;
	completedAt: number | null = null;
	visibleChars = 0;

	/** Session-level: last committed turn's prefix hashes for lock detection. */
	private previousPrefixHashes: string[] | null = null;
	private previousSysPromptHash: string | null = null;
	private previousCloudHitRate: number | null = null;
	/** Prefix hashes observed this turn; committed in finishTurn(). */
	private pendingPrefixHashes: string[] | null = null;
	/** Last successfully built audit card (for /cache-audit). */
	lastCard: CacheAuditCard | null = null;

	resetForNewTurn(): void {
		this.modelId = "";
		this.injection = null;
		this.prefix = null;
		this.dehydration = null;
		this.cloud = null;
		this.thinking = null;
		this.timing = {
			ttftMs: null,
			totalDurationMs: null,
			contextPercent: null,
			contextTokens: null,
			contextWindow: null,
		};
		this.requestStartedAt = null;
		this.firstTokenAt = null;
		this.completedAt = null;
		this.visibleChars = 0;
		this.pendingPrefixHashes = null;
	}

	recordInjection(opts: {
		repoCacheStatus: RepoCacheInjectStatus;
		repoCacheInjectedTokens: number;
		sysPrompt: string;
	}): InjectionSnapshot {
		const sysPromptHash = shortHash(opts.sysPrompt);
		const mutated =
			this.previousSysPromptHash != null && this.previousSysPromptHash !== sysPromptHash;
		const snap: InjectionSnapshot = {
			repoCacheStatus: opts.repoCacheStatus,
			repoCacheInjectedTokens: opts.repoCacheInjectedTokens,
			sysPromptHash,
			sysPromptMutated: mutated,
			sysPromptLabel: mutated ? "⚠️ SYS_MUTATED" : "✓ stable",
		};
		this.injection = snap;
		this.previousSysPromptHash = sysPromptHash;
		return snap;
	}

	/**
	 * Record context-hook metrics. Prefix lock uses the longest prefix seen this
	 * turn (last provider call in a tool loop wins); dehydration keeps the pass
	 * with the most omitted tools.
	 */
	recordContext(
		messages: readonly { role?: string; content?: unknown; toolCallId?: string; toolName?: string }[],
		dehydration: DehydrationSnapshot,
	): void {
		const currentHashes = hashMessagePrefix(messages);
		if (
			this.pendingPrefixHashes == null ||
			currentHashes.length >= this.pendingPrefixHashes.length
		) {
			this.pendingPrefixHashes = currentHashes;
			this.prefix = comparePrefixLocks(this.previousPrefixHashes, currentHashes);
		}
		if (
			this.dehydration == null ||
			dehydration.omittedTools > this.dehydration.omittedTools ||
			(dehydration.omittedTools === this.dehydration.omittedTools &&
				dehydration.rawEstTokens > this.dehydration.rawEstTokens)
		) {
			this.dehydration = dehydration;
		}
	}

	/** Commit this turn's prefix baseline for the next turn's lock check. */
	finishTurn(): void {
		// Never commit an empty baseline (e.g. context saw only [user] before
		// the assistant reply) — that would pin every later turn as FIRST_TURN.
		if (this.pendingPrefixHashes && this.pendingPrefixHashes.length > 0) {
			this.previousPrefixHashes = this.pendingPrefixHashes;
		}
		this.pendingPrefixHashes = null;
	}

	markRequestStart(now = Date.now()): void {
		if (this.requestStartedAt == null) {
			this.requestStartedAt = now;
		}
	}

	markFirstToken(now = Date.now()): void {
		if (this.firstTokenAt == null) {
			this.firstTokenAt = now;
			if (this.requestStartedAt != null) {
				this.timing.ttftMs = now - this.requestStartedAt;
			}
		}
	}

	markComplete(now = Date.now()): void {
		this.completedAt = now;
		if (this.requestStartedAt != null) {
			this.timing.totalDurationMs = now - this.requestStartedAt;
		}
	}

	recordAssistantUsage(usage: unknown, visibleChars: number): void {
		const cloud = extractCloudUsage(usage);
		this.visibleChars += visibleChars;
		if (cloud) {
			if (this.cloud) {
				this.cloud = {
					input: this.cloud.input + cloud.input,
					cacheRead: this.cloud.cacheRead + cloud.cacheRead,
					cacheWrite: this.cloud.cacheWrite + cloud.cacheWrite,
					output: this.cloud.output + cloud.output,
					reasoning:
						this.cloud.reasoning != null || cloud.reasoning != null
							? (this.cloud.reasoning ?? 0) + (cloud.reasoning ?? 0)
							: undefined,
				};
			} else {
				this.cloud = cloud;
			}
			this.thinking = estimateThinkingTax(
				this.cloud.output,
				this.visibleChars,
				this.cloud.reasoning,
			);
		}
	}

	recordContextUsage(usage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	} | undefined): void {
		if (!usage) return;
		this.timing.contextTokens = usage.tokens;
		this.timing.contextWindow = usage.contextWindow;
		this.timing.contextPercent = usage.percent;
	}

	buildCard(cfg: TelemetryConfig): CacheAuditCard | null {
		if (!this.injection || !this.prefix || !this.dehydration) {
			// Incomplete turn (e.g. aborted before context) — still allow if we have injection
			if (!this.injection) return null;
		}
		const injection = this.injection!;
		const prefix = this.prefix ?? { status: "first" as const, label: "🆕 FIRST_TURN" };
		const dehydration = this.dehydration ?? {
			rawEstTokens: 0,
			sentEstTokens: 0,
			omittedTools: 0,
			omittedSavedTokens: 0,
			omittedSavedRatio: null,
		};
		const hit = this.cloud ? cloudCacheHitRate(this.cloud) : null;
		const base: Omit<CacheAuditCard, "triggers"> = {
			modelId: this.modelId,
			injection,
			prefix,
			dehydration,
			cloud: this.cloud,
			cloudCacheHitRate: hit,
			prevCloudCacheHitRate: this.previousCloudHitRate,
			thinking: this.thinking,
			timing: { ...this.timing },
			timestamp: Date.now(),
		};
		const triggers = evaluateAuditTriggers(base, cfg);
		const card: CacheAuditCard = { ...base, triggers };
		if (hit != null) {
			this.previousCloudHitRate = hit;
		}
		this.lastCard = card;
		return card;
	}
}
