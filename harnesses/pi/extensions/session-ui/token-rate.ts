/**
 * Shared token / TTFT / tok/s state for the working row.
 *
 * Adapted from pi-cc-extensions token-rate (MIT), simplified for session-ui.
 */

export type TokenRateMode = "average" | "live";

const LIVE_WINDOW_MS = 1_000;
const MIN_SPAN_MS = 250;
const CJK_CHARS =
	/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

interface TokenSample {
	t: number;
	cum: number;
}

let runStartTime = 0;
let carriedTokens = 0;
let currentTokens = 0;
let pauseStartedAt = 0;
let activeTools = 0;
let lastRate = 0;
let lastLiveRate = 0;
let firstTokenAt = 0;
let samples: TokenSample[] = [];
let usageAnchorTime = 0;
let usageAnchorTokens = 0;
let countedUsage = 0;

export function resetTokenRate(startAt = 0): void {
	runStartTime = startAt;
	carriedTokens = 0;
	currentTokens = 0;
	pauseStartedAt = 0;
	activeTools = 0;
	lastRate = 0;
	lastLiveRate = 0;
	firstTokenAt = 0;
	samples = [];
	usageAnchorTime = 0;
	usageAnchorTokens = 0;
	countedUsage = 0;
}

export function carryTokenRate(): void {
	if (currentTokens > 0) carriedTokens += currentTokens;
	currentTokens = 0;
	countedUsage = 0;
}

export function pauseTokenRate(now = Date.now()): void {
	if (!runStartTime) return;
	activeTools += 1;
	if (activeTools === 1 && !pauseStartedAt) pauseStartedAt = now;
}

export function resumeTokenRate(): void {
	activeTools = Math.max(0, activeTools - 1);
	if (activeTools === 0 && pauseStartedAt) pauseStartedAt = 0;
}

export function markFirstToken(now = Date.now()): void {
	if (runStartTime && !firstTokenAt) firstTokenAt = now;
}

function estimateTokens(text: string): number {
	if (!text) return 0;
	const cjk = text.match(CJK_CHARS)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

function pushSample(time: number, cum: number): void {
	samples.push({ t: time, cum });
	const cutoff = time - LIVE_WINDOW_MS;
	while (samples.length > 1 && samples[0]!.t < cutoff) samples.shift();
}

function updateRates(now: number): void {
	const total = carriedTokens + currentTokens;
	const elapsed = (now - runStartTime) / 1000;
	if (elapsed > 0) lastRate = total / elapsed;
	if (samples.length < 2) return;
	const first = samples[0]!;
	const last = samples[samples.length - 1]!;
	const span = last.t - first.t;
	if (span >= MIN_SPAN_MS) {
		lastLiveRate = ((last.cum - first.cum) * 1000) / span;
	}
}

export function sampleTokenDelta(delta: string, now = Date.now()): void {
	if (!runStartTime) return;
	const added = estimateTokens(delta);
	if (added <= 0) return;
	currentTokens += added;
	if (pauseStartedAt) return;
	pushSample(now, carriedTokens + currentTokens);
	updateRates(now);
}

export function recordProviderUsage(output: number, now = Date.now(), final = false): void {
	if (!runStartTime || output <= 0) return;
	if (final) {
		const shift = output - currentTokens;
		for (const sample of samples) sample.cum += shift;
		countedUsage = output;
		currentTokens = output;
		usageAnchorTime = now;
		usageAnchorTokens = output;
		updateRates(now);
		return;
	}
	if (output <= countedUsage) return;
	const firstReport = countedUsage === 0;
	const jump = output - countedUsage;
	countedUsage = output;
	currentTokens = output;
	if (firstReport) {
		samples = samples.filter((sample) => sample.t < usageAnchorTime);
		pushSample(usageAnchorTime, carriedTokens + usageAnchorTokens);
	}
	const span = Math.max(now - usageAnchorTime, 1);
	const count = Math.min(Math.max(Math.ceil(jump / 16), 1), 32);
	const base = firstReport
		? carriedTokens + usageAnchorTokens
		: carriedTokens + currentTokens - jump;
	for (let i = 1; i <= count; i++) {
		pushSample(usageAnchorTime + (span * i) / count, base + (jump * i) / count);
	}
	usageAnchorTime = now;
	usageAnchorTokens = currentTokens;
	updateRates(now);
}

export function startMessageSegment(now = Date.now()): void {
	if (!runStartTime) return;
	usageAnchorTime = now;
	usageAnchorTokens = currentTokens;
	countedUsage = 0;
}

export function totalTokens(): number {
	return carriedTokens + currentTokens;
}

export function displayTokenRate(mode: TokenRateMode): number {
	if (mode === "live" && samples.length >= 2 && lastLiveRate > 0) {
		return lastLiveRate;
	}
	return lastRate;
}

export function currentTtftMs(): number {
	if (!runStartTime || !firstTokenAt) return 0;
	return Math.max(0, firstTokenAt - runStartTime);
}

export function formatTtft(ttftMs: number): string {
	if (ttftMs < 1000) return `${Math.round(ttftMs)}ms`;
	return `${(ttftMs / 1000).toFixed(1)}s`;
}

export function formatTokenCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(Math.max(0, ms) / 1000);
	if (totalSec < 1) return "0s";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatTokenRate(
	rate: number,
	ttftMs = 0,
	mode: TokenRateMode = "average",
	showTtft = true,
): string {
	if (!Number.isFinite(rate) || rate <= 0) return "";
	const value = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : `${Math.round(rate)}`;
	const ttft =
		showTtft && Number.isFinite(ttftMs) && ttftMs > 0 ? ` · TTFT ${formatTtft(ttftMs)}` : "";
	const label = mode === "live" ? "live" : "avg";
	return `${label} ${value} tok/s${ttft}`;
}
