import { collectStats, type CacheHitRates, type Stats } from "./statusline-usage.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import {
	findUnknownStatusSegments,
	fitStatuslineItems,
	isExtensionStatusExcluded,
	parseSubscriptionUsageEvent,
	separatorBetweenStatuslineSegments,
	type StatuslineOverflow,
	type SubscriptionUsageView,
	type SubscriptionUsageWindowKind,
} from "./statusline-core.ts";
import {
	ellipsize,
	formatEffortWithFast,
	formatTokens,
	sanitizeTerminalText,
	segment,
	statusColor,
} from "./shared.ts";

const I_MODEL = "\uF2DB";
const I_DIR = "\uF07B";
const I_BRANCH = "\uE0A0";
const I_CTX = "\uF1C0";
const I_SESSION = "\uF02B";
const I_TOKENS = "\uF1C9";
const I_CACHE = "\uF49B";
const I_USAGE_HOURLY = "\uF017";
const I_USAGE_WEEKLY = "\uF073";
const I_USAGE_MONTHLY = "\uF133";
const I_USAGE_ROLLING = "\uF01E";
const I_USAGE_QUOTA = "\uF0E4";
const I_SEP = "\uE0B1";
const SUBSCRIPTION_USAGE_EVENT = "subscription-usage/status/v1";
const AUTO_MODEL_STATUS_EVENT = "auto-model/status/v1";
const REGISTER_SEGMENT_EVENT = "session-ui/statusline/register/v1";

export interface AutoModelStatusView {
	enabled: boolean;
	phase?: "SCOUT" | "PLAN" | "EXECUTE";
}

function loadInitialAutoModelStatus(cwd: string): AutoModelStatusView | undefined {
	try {
		const stateDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
		const globalPath = join(stateDir, "state", "auto-model-router.json");
		const localPath = join(cwd, ".pi", "model-router.json");

		let autoEnabled = true;
		if (existsSync(localPath)) {
			const parsed = JSON.parse(readFileSync(localPath, "utf8"));
			if (typeof parsed.autoEnabled === "boolean") autoEnabled = parsed.autoEnabled;
		} else if (existsSync(globalPath)) {
			const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
			if (typeof parsed.autoEnabled === "boolean") autoEnabled = parsed.autoEnabled;
		}

		if (autoEnabled) {
			return { enabled: true, phase: "EXECUTE" };
		}
	} catch {}
	return undefined;
}

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}

function remainingUsageColor(percent: number): ThemeColor {
	if (percent >= 50) return "success";
	if (percent >= 25) return "warning";
	return "error";
}

function usageWindowIcon(kind: SubscriptionUsageWindowKind): string {
	if (kind === "hourly" || kind === "daily") return I_USAGE_HOURLY;
	if (kind === "weekly") return I_USAGE_WEEKLY;
	if (kind === "monthly") return I_USAGE_MONTHLY;
	if (kind === "rolling") return I_USAGE_ROLLING;
	return I_USAGE_QUOTA;
}

export interface StatusSegmentValue {
	full: string;
	compact?: string;
}

export interface StatusSegmentContext {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	theme: Theme;
	footerData: FooterData;
	stats: Stats;
}

export interface StatusSegment {
	id: string;
	priority: number;
	required?: boolean;
	render(context: StatusSegmentContext): StatusSegmentValue | undefined;
}

interface RenderedSegment extends StatusSegmentValue {
	id: string;
	priority: number;
	required: boolean;
	value: string;
}

class StatusSegmentRegistry {
	private readonly segments = new Map<string, StatusSegment>();

	register(segmentDefinition: StatusSegment): void {
		this.segments.set(segmentDefinition.id, segmentDefinition);
	}

	get(id: string): StatusSegment | undefined {
		return this.segments.get(id);
	}

	ids(): ReadonlySet<string> {
		return new Set(this.segments.keys());
	}
}

function formatCacheHitRates(rates: CacheHitRates): string | undefined {
	const values = [rates.current, rates.rolling5, rates.session];
	if (values.every((rate) => rate === undefined)) return undefined;
	return values
		.map((rate) => (rate === undefined ? "-" : `${Math.round(rate)}%`))
		.join("/");
}

function shortenHomePath(value: string): string {
	const home = homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
	return value;
}

export function layoutStatusSegments(
	segments: readonly RenderedSegment[],
	width: number,
	separator: string,
	overflow: StatuslineOverflow,
): string {
	const fitted = fitStatuslineItems(
		segments.map((segmentDefinition) => ({
			id: segmentDefinition.id,
			priority: segmentDefinition.priority,
			required: segmentDefinition.required,
			value: segmentDefinition.value,
			width: visibleWidth(segmentDefinition.value),
			...(segmentDefinition.compact
				? {
						compactValue: segmentDefinition.compact,
						compactWidth: visibleWidth(segmentDefinition.compact),
					}
				: {}),
		})),
		width,
		(left, right) =>
			visibleWidth(
				separatorBetweenStatuslineSegments(left.id, right.id, separator),
			),
		overflow,
	);
	const line = fitted
		.map((item, index) => {
			if (index === 0) return item.value;
			const previous = fitted[index - 1]!;
			return `${separatorBetweenStatuslineSegments(previous.id, item.id, separator)}${item.value}`;
		})
		.join("");
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width);
}

function registerBuiltInSegments(
	registry: StatusSegmentRegistry,
	getUsageFromEvent: () => SubscriptionUsageView | undefined,
	getAutoModelStatus: () => AutoModelStatusView | undefined,
	excludedExtensionStatuses: readonly string[],
): void {
	registry.register({
		id: "model",
		priority: 100,
		required: true,
		render: ({ ctx, theme }) => {
			const fullName = ctx.model?.name || ctx.model?.id || "no-model";
			const compactName = ctx.model?.id || fullName;
			const autoStatus = getAutoModelStatus();

			if (autoStatus?.enabled && autoStatus.phase) {
				const phaseShort = autoStatus.phase === "EXECUTE" ? "EXEC" : autoStatus.phase;
				const fullTag = `Auto[${phaseShort}] · ${fullName}`;
				const compactTag = `[${phaseShort}] ${ellipsize(compactName, 14)}`;
				return {
					full: segment(theme, "accent", I_MODEL, theme.bold(fullTag)),
					compact: segment(theme, "accent", I_MODEL, theme.bold(compactTag)),
				};
			}

			return {
				full: segment(theme, "accent", I_MODEL, theme.bold(fullName)),
				compact: segment(
					theme,
					"accent",
					I_MODEL,
					theme.bold(ellipsize(compactName, 20)),
				),
			};
		},
	});

	registry.register({
		id: "effort",
		priority: 80,
		render: ({ pi, theme, footerData }) => {
			const full = formatEffortWithFast(
				theme,
				pi.getThinkingLevel(),
				footerData.getExtensionStatuses().get("fast"),
			);
			return full ? { full } : undefined;
		},
	});

	registry.register({
		id: "directory",
		priority: 65,
		render: ({ ctx, theme }) => ({
			full: segment(theme, "mdLink", I_DIR, shortenHomePath(ctx.cwd)),
			compact: segment(theme, "mdLink", I_DIR, basename(ctx.cwd) || "."),
		}),
	});

	registry.register({
		id: "session",
		priority: 55,
		render: ({ ctx, theme }) => {
			const name = ctx.sessionManager.getSessionName();
			if (!name) return undefined;
			const safe = sanitizeTerminalText(name);
			return {
				full: segment(theme, "muted", I_SESSION, safe),
				compact: segment(theme, "muted", I_SESSION, ellipsize(safe, 18)),
			};
		},
	});

	registry.register({
		id: "branch",
		priority: 60,
		render: ({ theme, footerData }) => {
			const branch = footerData.getGitBranch();
			if (!branch) return undefined;
			const safe = sanitizeTerminalText(branch);
			return {
				full: segment(theme, "warning", I_BRANCH, safe),
				compact: segment(theme, "warning", I_BRANCH, ellipsize(safe, 16)),
			};
		},
	});

	registry.register({
		id: "context",
		priority: 95,
		required: true,
		render: ({ ctx, theme }) => {
			const usage = ctx.getContextUsage();
			if (!usage) return undefined;
			const window = usage.contextWindow || ctx.model?.contextWindow || 0;
			if (usage.percent == null) {
				return {
					full: segment(theme, "success", I_CTX, `?%/${formatTokens(window)}`),
				};
			}
			const percent = Math.round(usage.percent);
			const colored = theme.fg(statusColor(percent), theme.bold(`${percent}%`));
			return {
				full: segment(
					theme,
					"success",
					I_CTX,
					`${colored}/${formatTokens(window)}`,
				),
				compact: segment(theme, "success", I_CTX, colored),
			};
		},
	});

	registry.register({
		id: "usage",
		priority: 90,
		render: ({ theme }) => {
			const usage = getUsageFromEvent();
			if (!usage) return undefined;
			const value = usage.windows
				.map((window) => {
					const icon = theme.fg("accent", usageWindowIcon(window.kind));
					const percent = theme.fg(
						remainingUsageColor(window.remainingPercent),
						theme.bold(`${Math.round(window.displayPercent)}%`),
					);
					const reset = window.resetCountdown
						? ` ${theme.fg("dim", `\u21BB${window.resetCountdown}`)}`
						: "";
					return `${icon} ${window.label} ${percent}${reset}`;
				})
				.join("  ");
			const compact = usage.windows
				.map((window) => {
					const icon = theme.fg("accent", usageWindowIcon(window.kind));
					const percent = theme.fg(
						remainingUsageColor(window.remainingPercent),
						theme.bold(`${Math.round(window.displayPercent)}%`),
					);
					return `${icon} ${window.label} ${percent}`;
				})
				.join(" ");
			return value ? { full: value, compact } : undefined;
		},
	});

	registry.register({
		id: "tokens",
		priority: 35,
		render: ({ stats, theme }) => {
			if (stats.input <= 0 && stats.output <= 0) return undefined;
			return {
				full: segment(
					theme,
					"accent",
					I_TOKENS,
					`↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)}`,
				),
			};
		},
	});

	registry.register({
		id: "cache",
		priority: 25,
		render: ({ stats, theme }) => {
			const rates = formatCacheHitRates(stats.cacheHitRates);
			return rates
				? { full: segment(theme, "success", I_CACHE, rates) }
				: undefined;
		},
	});

	registry.register({
		id: "extensions",
		priority: 10,
		render: ({ footerData, theme }) => {
			const statuses = [...footerData.getExtensionStatuses().entries()]
				.filter(
					([id, value]) =>
						Boolean(value) &&
						!isExtensionStatusExcluded(id, excludedExtensionStatuses),
				)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, value]) => sanitizeTerminalText(value))
				.filter(Boolean);
			if (statuses.length === 0) return undefined;
			const separator = `  ${theme.fg("accent", I_SEP)}  `;
			return {
				full: statuses.join(separator),
				compact: `+${statuses.length} status`,
			};
		},
	});
}

function isStatusSegment(value: unknown): value is StatusSegment {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StatusSegment>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.priority === "number" &&
		typeof candidate.render === "function"
	);
}

export function registerStatusline(
	pi: ExtensionAPI,
	config: SessionUiConfig["statusline"],
): void {
	const registry = new StatusSegmentRegistry();
	let enabled = true;
	let requestRender: (() => void) | undefined;
	let statsCache: { length: number; stats: Stats } | undefined;
	let usageFromEvent: SubscriptionUsageView | undefined;
	let autoModelFromEvent: AutoModelStatusView | undefined;
	registerBuiltInSegments(
		registry,
		() => usageFromEvent,
		() => autoModelFromEvent,
		config.extensionStatuses.exclude,
	);

	pi.events.on(SUBSCRIPTION_USAGE_EVENT, (data) => {
		usageFromEvent = parseSubscriptionUsageEvent(data);
		requestRender?.();
	});

	pi.events.on(AUTO_MODEL_STATUS_EVENT, (data) => {
		if (data && typeof data === "object" && (data as any).v === 1) {
			autoModelFromEvent = {
				enabled: (data as any).enabled === true,
				phase: (data as any).phase,
			};
			requestRender?.();
		}
	});

	pi.events.on(REGISTER_SEGMENT_EVENT, (value) => {
		if (!isStatusSegment(value)) return;
		registry.register(value);
		requestRender?.();
	});

	const getStats = (ctx: ExtensionContext): Stats => {
		const entries = ctx.sessionManager.getEntries();
		if (!statsCache || statsCache.length !== entries.length) {
			statsCache = { length: entries.length, stats: collectStats(entries) };
		}
		return statsCache.stats;
	};

	const apply = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			requestRender = undefined;
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => {
				statsCache = undefined;
				tui.requestRender();
			});
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const context: StatusSegmentContext = {
						pi,
						ctx,
						theme,
						footerData: footerData as FooterData,
						stats: getStats(ctx),
					};
					const rendered = config.segments.flatMap((id) => {
						const definition = registry.get(id);
						if (!definition) return [];
						const value = definition.render(context);
						if (!value?.full) return [];
						return [
							{
								id,
								priority: definition.priority,
								required: definition.required === true,
								...value,
								value: value.full,
							} satisfies RenderedSegment,
						];
					});
					const separator = `  ${theme.fg("accent", I_SEP)}  `;
					return [layoutStatusSegments(rendered, width, separator, config.overflow)];
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		statsCache = undefined;
		usageFromEvent = undefined;
		autoModelFromEvent = autoModelFromEvent ?? loadInitialAutoModelStatus(ctx.cwd);
		const unknownSegments = findUnknownStatusSegments(
			config.segments,
			registry.ids(),
		);
		if (unknownSegments.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Unknown statusline segments ignored: ${unknownSegments.join(", ")}`,
				"warning",
			);
		}
		apply(ctx);
		pi.events.emit("session-ui/statusline/ready/v1");
	});

	const refresh = () => requestRender?.();
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("session_info_changed", refresh);

	pi.registerCommand("statusline", {
		description: "Toggle the session UI statusline",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(
				enabled ? "Custom statusline enabled" : "Default footer restored",
				"info",
			);
		},
	});
}
