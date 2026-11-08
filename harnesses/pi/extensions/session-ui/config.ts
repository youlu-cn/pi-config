import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StatuslineOverflow } from "./statusline-core.ts";
import type { DiffIndicatorMode, DiffViewMode } from "./rich-diff-core.ts";
import type { TokenRateMode } from "./token-rate.ts";
import {
	isValidAnimationStyle,
	VALID_ANIMATION_STYLES,
	type AnimationStyle,
} from "./work-animation-core.ts";

export type WidgetPlacement = "aboveEditor" | "belowEditor";
export type ClaudeToolStyleMode = "on" | "compact" | "off";

export interface SessionUiConfig {
	toolActivity: {
		enabled: boolean;
		placement: WidgetPlacement;
		maxItems: number;
	};
	workAnimation: {
		enabled: boolean;
		style?: AnimationStyle;
		intervalMs: number;
		placement: WidgetPlacement;
		/** Append ↓ tokens · elapsed · tok/s · TTFT to the working row. */
		showStats: boolean;
		showTtft: boolean;
		tokenRateMode: TokenRateMode;
	};
	agentSummary: {
		enabled: boolean;
		minToolCount: number;
	};
	compactThinking: {
		enabled: boolean;
		previewLines: number;
		completedPreviewLines: number | null;
		animationIntervalMs: number;
	};
	compactPaste: {
		enabled: boolean;
	};
	/** Claude Code-style ❯ prompt prefix. */
	editorPrefix: {
		enabled: boolean;
	};
	/** /clear → new session, /exit → shutdown. */
	aliases: {
		enabled: boolean;
	};
	/** AskUserQuestion / Codemode / Subagent dedicated cards. */
	specialCards: {
		enabled: boolean;
	};
	claudeToolStyle: {
		enabled: boolean;
		style?: AnimationStyle;
		intervalMs?: number;
		/** on = rich cards; compact = one-line until expand; off = native Pi renderer */
		mode: ClaudeToolStyleMode;
		/** Collapse consecutive tool cards into a group header. */
		grouping: boolean;
		diffViewMode: DiffViewMode;
		diffIndicatorMode: DiffIndicatorMode;
		diffSplitMinWidth: number;
		editDiffCollapsedLines: number;
		writeDiffCollapsedLines: number;
	};
	statusline: {
		enabled: boolean;
		overflow: StatuslineOverflow;
		segments: string[];
		extensionStatuses: {
			exclude: string[];
		};
	};
	effort: {
		enabled: boolean;
	};
	turnSummary: {
		enabled: boolean;
		showDuration: boolean;
		showModel: boolean;
		showEffort: boolean;
	};
	/** @deprecated Use turnSummary instead */
	turnDuration: {
		enabled: boolean;
		showDuration: boolean;
		showModel: boolean;
		showEffort: boolean;
	};
	uiMeta: {
		enabled: boolean;
		title: {
			enabled: boolean;
			maxLength: number;
		};
		sessionName: {
			enabled: boolean;
			maxLength: number;
		};
	};
	/** Claude-style startup header (gradient logo + keybinding tips + hero). */
	startupHeader: {
		enabled: boolean;
	};
	/** Mermaid dialect fences + circled-number normalization. */
	markdownEnhance: {
		enabled: boolean;
	};
	/** /context context-window breakdown panel (keyboard MVP). */
	contextCommand: {
		enabled: boolean;
	};
	/** @session:[…] / @subagent:[…] references + autocomplete. */
	reference: {
		/** Master switch for both session refs and subagent autocomplete. */
		enabled: boolean;
		/** Inject prior-session transcripts via @session:[…]. */
		sessionReference: boolean;
		/** Suggest agent types via @subagent:[…] and inject delegation hints. */
		subagentAutocomplete: boolean;
	};
	/** Pin scrolled-off user message to the fullscreen viewport top. */
	stickyUserMessage: {
		enabled: boolean;
	};
}

export const DEFAULT_SESSION_UI_CONFIG: SessionUiConfig = {
	toolActivity: {
		enabled: true,
		placement: "aboveEditor",
		maxItems: 6,
	},
	workAnimation: {
		enabled: true,
		intervalMs: 240,
		placement: "aboveEditor",
		showStats: true,
		showTtft: true,
		tokenRateMode: "average",
	},
	agentSummary: {
		enabled: true,
		minToolCount: 1,
	},
	compactThinking: {
		enabled: true,
		previewLines: 3,
		completedPreviewLines: 1,
		animationIntervalMs: 90,
	},
	compactPaste: {
		enabled: true,
	},
	editorPrefix: {
		enabled: true,
	},
	aliases: {
		enabled: true,
	},
	specialCards: {
		enabled: true,
	},
	claudeToolStyle: {
		enabled: true,
		mode: "on",
		grouping: true,
		diffViewMode: "auto",
		diffIndicatorMode: "bars",
		diffSplitMinWidth: 120,
		editDiffCollapsedLines: 12,
		writeDiffCollapsedLines: 8,
	},
	statusline: {
		enabled: true,
		overflow: "drop-right",
		segments: [
			"model",
			"effort",
			"directory",
			"branch",
			"context",
			"usage",
			"tokens",
			"cache",
			"extensions",
		],
		extensionStatuses: {
			exclude: [
				"fast",
				"mcp",
				"mcp-*",
				"subscription-usage",
			],
		},
	},
	effort: {
		enabled: true,
	},
	turnSummary: {
		enabled: true,
		showDuration: true,
		showModel: true,
		showEffort: true,
	},
	turnDuration: {
		enabled: true,
		showDuration: true,
		showModel: true,
		showEffort: true,
	},
	uiMeta: {
		enabled: true,
		title: {
			enabled: true,
			maxLength: 36,
		},
		sessionName: {
			enabled: true,
			maxLength: 48,
		},
	},
	startupHeader: {
		enabled: true,
	},
	markdownEnhance: {
		enabled: true,
	},
	contextCommand: {
		enabled: true,
	},
	reference: {
		enabled: true,
		sessionReference: true,
		subagentAutocomplete: true,
	},
	stickyUserMessage: {
		enabled: true,
	},
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(
	value: unknown,
	fallback: boolean,
	path: string,
	warnings: string[],
): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${path} must be a boolean`);
	return fallback;
}

function boundedInteger(
	value: unknown,
	fallback: number,
	path: string,
	min: number,
	max: number,
	warnings: string[],
): number {
	if (value === undefined) return fallback;
	if (
		Number.isInteger(value) &&
		(value as number) >= min &&
		(value as number) <= max
	) {
		return value as number;
	}
	warnings.push(`${path} must be an integer between ${min} and ${max}`);
	return fallback;
}

function objectValue(
	value: unknown,
	path: string,
	warnings: string[],
): JsonObject {
	if (value === undefined) return {};
	if (isObject(value)) return value;
	warnings.push(`${path} must be an object`);
	return {};
}

function stringArrayValue(
	value: unknown,
	fallback: readonly string[],
	path: string,
	warnings: string[],
): string[] {
	if (value === undefined) return [...fallback];
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string" && entry.trim())
	) {
		return [...new Set(value.map((entry) => entry.trim()))];
	}
	warnings.push(`${path} must be an array of non-empty strings`);
	return [...fallback];
}

function parseConfig(raw: unknown, warnings: string[]): SessionUiConfig {
	if (!isObject(raw)) {
		warnings.push("config root must be an object");
		return structuredClone(DEFAULT_SESSION_UI_CONFIG);
	}

	const toolActivity = objectValue(raw.toolActivity, "toolActivity", warnings);
	const workAnimation = objectValue(raw.workAnimation, "workAnimation", warnings);
	const agentSummary = objectValue(raw.agentSummary, "agentSummary", warnings);
	const compactThinking = objectValue(raw.compactThinking, "compactThinking", warnings);
	const compactPaste = objectValue(raw.compactPaste, "compactPaste", warnings);
	const editorPrefix = objectValue(raw.editorPrefix, "editorPrefix", warnings);
	const aliases = objectValue(raw.aliases, "aliases", warnings);
	const specialCards = objectValue(raw.specialCards, "specialCards", warnings);
	const claudeToolStyle = objectValue(raw.claudeToolStyle, "claudeToolStyle", warnings);
	const statusline = objectValue(raw.statusline, "statusline", warnings);
	const extensionStatuses = objectValue(
		statusline.extensionStatuses, "statusline.extensionStatuses", warnings,
	);
	const effort = objectValue(raw.effort, "effort", warnings);
	const turnSummaryKey = raw.turnSummary !== undefined ? "turnSummary" : "turnDuration";
	const rawTurnSummary = raw[turnSummaryKey];
	const turnSummary = objectValue(rawTurnSummary, turnSummaryKey, warnings);
	const uiMeta = objectValue(raw.uiMeta, "uiMeta", warnings);
	const uiMetaTitle = objectValue(uiMeta.title, "uiMeta.title", warnings);
	const uiMetaSessionName = objectValue(
		uiMeta.sessionName, "uiMeta.sessionName", warnings,
	);
	const startupHeader = objectValue(raw.startupHeader, "startupHeader", warnings);
	const markdownEnhance = objectValue(raw.markdownEnhance, "markdownEnhance", warnings);
	const contextCommand = objectValue(raw.contextCommand, "contextCommand", warnings);
	const reference = objectValue(raw.reference, "reference", warnings);
	const stickyUserMessage = objectValue(
		raw.stickyUserMessage,
		"stickyUserMessage",
		warnings,
	);

	let placement = DEFAULT_SESSION_UI_CONFIG.toolActivity.placement;
	if (toolActivity.placement !== undefined) {
		if (
			toolActivity.placement === "aboveEditor" ||
			toolActivity.placement === "belowEditor"
		) {
			placement = toolActivity.placement;
		} else {
			warnings.push("toolActivity.placement must be aboveEditor or belowEditor");
		}
	}

	let animationPlacement = DEFAULT_SESSION_UI_CONFIG.workAnimation.placement;
	if (workAnimation.placement !== undefined) {
		if (
			workAnimation.placement === "aboveEditor" ||
			workAnimation.placement === "belowEditor"
		) {
			animationPlacement = workAnimation.placement;
		} else {
			warnings.push("workAnimation.placement must be aboveEditor or belowEditor");
		}
	}

	let animationStyle: AnimationStyle | undefined;
	if (workAnimation.style !== undefined) {
		if (isValidAnimationStyle(workAnimation.style)) {
			animationStyle = workAnimation.style;
		} else {
			warnings.push(
				`workAnimation.style must be one of: ${VALID_ANIMATION_STYLES.join(", ")}`,
			);
		}
	}

	let tokenRateMode = DEFAULT_SESSION_UI_CONFIG.workAnimation.tokenRateMode;
	if (workAnimation.tokenRateMode !== undefined) {
		if (workAnimation.tokenRateMode === "average" || workAnimation.tokenRateMode === "live") {
			tokenRateMode = workAnimation.tokenRateMode;
		} else {
			warnings.push("workAnimation.tokenRateMode must be average or live");
		}
	}

	let compactCompletedPreview: number | null =
		DEFAULT_SESSION_UI_CONFIG.compactThinking.completedPreviewLines;
	if (compactThinking.completedPreviewLines !== undefined) {
		if (
			compactThinking.completedPreviewLines === null ||
			(typeof compactThinking.completedPreviewLines === "number" &&
				Number.isInteger(compactThinking.completedPreviewLines) &&
				compactThinking.completedPreviewLines >= 0)
		) {
			compactCompletedPreview = compactThinking.completedPreviewLines as number | null;
		} else {
			warnings.push(
				"compactThinking.completedPreviewLines must be null or a non-negative integer",
			);
		}
	}

	let toolAnimationStyle: AnimationStyle | undefined;
	if (claudeToolStyle.style !== undefined) {
		if (isValidAnimationStyle(claudeToolStyle.style)) {
			toolAnimationStyle = claudeToolStyle.style;
		} else {
			warnings.push(
				`claudeToolStyle.style must be one of: ${VALID_ANIMATION_STYLES.join(", ")}`,
			);
		}
	}

	let toolIntervalMs: number | undefined;
	if (claudeToolStyle.intervalMs !== undefined) {
		toolIntervalMs = boundedInteger(
			claudeToolStyle.intervalMs,
			180,
			"claudeToolStyle.intervalMs",
			100,
			500,
			warnings,
		);
	}

	let toolMode: ClaudeToolStyleMode = DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.mode;
	if (claudeToolStyle.mode !== undefined) {
		if (
			claudeToolStyle.mode === "on" ||
			claudeToolStyle.mode === "compact" ||
			claudeToolStyle.mode === "off"
		) {
			toolMode = claudeToolStyle.mode;
		} else {
			warnings.push("claudeToolStyle.mode must be on, compact, or off");
		}
	}

	let diffViewMode = DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.diffViewMode;
	if (claudeToolStyle.diffViewMode !== undefined) {
		if (
			claudeToolStyle.diffViewMode === "auto" ||
			claudeToolStyle.diffViewMode === "unified" ||
			claudeToolStyle.diffViewMode === "split"
		) {
			diffViewMode = claudeToolStyle.diffViewMode;
		} else {
			warnings.push("claudeToolStyle.diffViewMode must be auto, unified, or split");
		}
	}

	let diffIndicatorMode = DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.diffIndicatorMode;
	if (claudeToolStyle.diffIndicatorMode !== undefined) {
		if (
			claudeToolStyle.diffIndicatorMode === "bars" ||
			claudeToolStyle.diffIndicatorMode === "classic" ||
			claudeToolStyle.diffIndicatorMode === "none"
		) {
			diffIndicatorMode = claudeToolStyle.diffIndicatorMode;
		} else {
			warnings.push("claudeToolStyle.diffIndicatorMode must be bars, classic, or none");
		}
	}

	let overflow = DEFAULT_SESSION_UI_CONFIG.statusline.overflow;
	if (statusline.overflow !== undefined) {
		if (
			statusline.overflow === "drop-right" ||
			statusline.overflow === "priority"
		) {
			overflow = statusline.overflow;
		} else {
			warnings.push("statusline.overflow must be drop-right or priority");
		}
	}
	const segments = stringArrayValue(
		statusline.segments,
		DEFAULT_SESSION_UI_CONFIG.statusline.segments,
		"statusline.segments",
		warnings,
	);
	const excludedExtensionStatuses = stringArrayValue(
		extensionStatuses.exclude,
		DEFAULT_SESSION_UI_CONFIG.statusline.extensionStatuses.exclude,
		"statusline.extensionStatuses.exclude",
		warnings,
	);

	return {
		toolActivity: {
			enabled: booleanValue(
				toolActivity.enabled,
				DEFAULT_SESSION_UI_CONFIG.toolActivity.enabled,
				"toolActivity.enabled",
				warnings,
			),
			placement,
			maxItems: boundedInteger(
				toolActivity.maxItems,
				DEFAULT_SESSION_UI_CONFIG.toolActivity.maxItems,
				"toolActivity.maxItems",
				1,
				20,
				warnings,
			),
		},
		workAnimation: {
			enabled: booleanValue(
				workAnimation.enabled,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.enabled,
				"workAnimation.enabled",
				warnings,
			),
			...(animationStyle !== undefined ? { style: animationStyle } : {}),
			intervalMs: boundedInteger(
				workAnimation.intervalMs,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.intervalMs,
				"workAnimation.intervalMs",
				100,
				500,
				warnings,
			),
			placement: animationPlacement,
			showStats: booleanValue(
				workAnimation.showStats,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.showStats,
				"workAnimation.showStats",
				warnings,
			),
			showTtft: booleanValue(
				workAnimation.showTtft,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.showTtft,
				"workAnimation.showTtft",
				warnings,
			),
			tokenRateMode,
		},
		agentSummary: {
			enabled: booleanValue(
				agentSummary.enabled,
				DEFAULT_SESSION_UI_CONFIG.agentSummary.enabled,
				"agentSummary.enabled",
				warnings,
			),
			minToolCount: boundedInteger(
				agentSummary.minToolCount,
				DEFAULT_SESSION_UI_CONFIG.agentSummary.minToolCount,
				"agentSummary.minToolCount",
				1,
				50,
				warnings,
			),
		},
		compactThinking: {
			enabled: booleanValue(
				compactThinking.enabled,
				DEFAULT_SESSION_UI_CONFIG.compactThinking.enabled,
				"compactThinking.enabled",
				warnings,
			),
			previewLines: boundedInteger(
				compactThinking.previewLines,
				DEFAULT_SESSION_UI_CONFIG.compactThinking.previewLines,
				"compactThinking.previewLines",
				0,
				40,
				warnings,
			),
			completedPreviewLines: compactCompletedPreview,
			animationIntervalMs: boundedInteger(
				compactThinking.animationIntervalMs,
				DEFAULT_SESSION_UI_CONFIG.compactThinking.animationIntervalMs,
				"compactThinking.animationIntervalMs",
				40,
				500,
				warnings,
			),
		},
		compactPaste: {
			enabled: booleanValue(
				compactPaste.enabled,
				DEFAULT_SESSION_UI_CONFIG.compactPaste.enabled,
				"compactPaste.enabled",
				warnings,
			),
		},
		editorPrefix: {
			enabled: booleanValue(
				editorPrefix.enabled,
				DEFAULT_SESSION_UI_CONFIG.editorPrefix.enabled,
				"editorPrefix.enabled",
				warnings,
			),
		},
		aliases: {
			enabled: booleanValue(
				aliases.enabled,
				DEFAULT_SESSION_UI_CONFIG.aliases.enabled,
				"aliases.enabled",
				warnings,
			),
		},
		specialCards: {
			enabled: booleanValue(
				specialCards.enabled,
				DEFAULT_SESSION_UI_CONFIG.specialCards.enabled,
				"specialCards.enabled",
				warnings,
			),
		},
		claudeToolStyle: {
			enabled: booleanValue(
				claudeToolStyle.enabled,
				DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.enabled,
				"claudeToolStyle.enabled",
				warnings,
			),
			...(toolAnimationStyle !== undefined ? { style: toolAnimationStyle } : {}),
			...(toolIntervalMs !== undefined ? { intervalMs: toolIntervalMs } : {}),
			mode: toolMode,
			grouping: booleanValue(
				claudeToolStyle.grouping,
				DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.grouping,
				"claudeToolStyle.grouping",
				warnings,
			),
			diffViewMode,
			diffIndicatorMode,
			diffSplitMinWidth: boundedInteger(
				claudeToolStyle.diffSplitMinWidth,
				DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.diffSplitMinWidth,
				"claudeToolStyle.diffSplitMinWidth",
				60,
				300,
				warnings,
			),
			editDiffCollapsedLines: boundedInteger(
				claudeToolStyle.editDiffCollapsedLines,
				DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.editDiffCollapsedLines,
				"claudeToolStyle.editDiffCollapsedLines",
				0,
				200,
				warnings,
			),
			writeDiffCollapsedLines: boundedInteger(
				claudeToolStyle.writeDiffCollapsedLines,
				DEFAULT_SESSION_UI_CONFIG.claudeToolStyle.writeDiffCollapsedLines,
				"claudeToolStyle.writeDiffCollapsedLines",
				0,
				200,
				warnings,
			),
		},
		statusline: {
			enabled: booleanValue(
				statusline.enabled,
				DEFAULT_SESSION_UI_CONFIG.statusline.enabled,
				"statusline.enabled",
				warnings,
			),
			overflow,
			segments,
			extensionStatuses: {
				exclude: excludedExtensionStatuses,
			},
		},
		effort: {
			enabled: booleanValue(
				effort.enabled,
				DEFAULT_SESSION_UI_CONFIG.effort.enabled,
				"effort.enabled",
				warnings,
			),
		},
		turnSummary: {
			enabled: booleanValue(
				turnSummary.enabled,
				DEFAULT_SESSION_UI_CONFIG.turnSummary.enabled,
				"turnSummary.enabled",
				warnings,
			),
			showDuration: booleanValue(
				turnSummary.showDuration,
				DEFAULT_SESSION_UI_CONFIG.turnSummary.showDuration,
				"turnSummary.showDuration",
				warnings,
			),
			showModel: booleanValue(
				turnSummary.showModel,
				DEFAULT_SESSION_UI_CONFIG.turnSummary.showModel,
				"turnSummary.showModel",
				warnings,
			),
			showEffort: booleanValue(
				turnSummary.showEffort,
				DEFAULT_SESSION_UI_CONFIG.turnSummary.showEffort,
				"turnSummary.showEffort",
				warnings,
			),
		},
		get turnDuration() {
			return this.turnSummary;
		},
		uiMeta: {
			enabled: booleanValue(
				uiMeta.enabled,
				DEFAULT_SESSION_UI_CONFIG.uiMeta.enabled,
				"uiMeta.enabled",
				warnings,
			),
			title: {
				enabled: booleanValue(
					uiMetaTitle.enabled,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.title.enabled,
					"uiMeta.title.enabled",
					warnings,
				),
				maxLength: boundedInteger(
					uiMetaTitle.maxLength,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.title.maxLength,
					"uiMeta.title.maxLength",
					8,
					80,
					warnings,
				),
			},
			sessionName: {
				enabled: booleanValue(
					uiMetaSessionName.enabled,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.sessionName.enabled,
					"uiMeta.sessionName.enabled",
					warnings,
				),
				maxLength: boundedInteger(
					uiMetaSessionName.maxLength,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.sessionName.maxLength,
					"uiMeta.sessionName.maxLength",
					8,
					100,
					warnings,
				),
			},
		},
		startupHeader: {
			enabled: booleanValue(
				startupHeader.enabled,
				DEFAULT_SESSION_UI_CONFIG.startupHeader.enabled,
				"startupHeader.enabled",
				warnings,
			),
		},
		markdownEnhance: {
			enabled: booleanValue(
				markdownEnhance.enabled,
				DEFAULT_SESSION_UI_CONFIG.markdownEnhance.enabled,
				"markdownEnhance.enabled",
				warnings,
			),
		},
		contextCommand: {
			enabled: booleanValue(
				contextCommand.enabled,
				DEFAULT_SESSION_UI_CONFIG.contextCommand.enabled,
				"contextCommand.enabled",
				warnings,
			),
		},
		reference: {
			enabled: booleanValue(
				reference.enabled,
				DEFAULT_SESSION_UI_CONFIG.reference.enabled,
				"reference.enabled",
				warnings,
			),
			sessionReference: booleanValue(
				reference.sessionReference,
				DEFAULT_SESSION_UI_CONFIG.reference.sessionReference,
				"reference.sessionReference",
				warnings,
			),
			subagentAutocomplete: booleanValue(
				reference.subagentAutocomplete,
				DEFAULT_SESSION_UI_CONFIG.reference.subagentAutocomplete,
				"reference.subagentAutocomplete",
				warnings,
			),
		},
		stickyUserMessage: {
			enabled: booleanValue(
				stickyUserMessage.enabled,
				DEFAULT_SESSION_UI_CONFIG.stickyUserMessage.enabled,
				"stickyUserMessage.enabled",
				warnings,
			),
		},
	};
}

export interface LoadedSessionUiConfig {
	config: SessionUiConfig;
	warnings: string[];
	path: string;
}

export function loadSessionUiConfig(): LoadedSessionUiConfig {
	const defaultPath = fileURLToPath(new URL("./config.json", import.meta.url));
	const overridePath = process.env.PI_SESSION_UI_CONFIG?.trim();
	const path = overridePath || defaultPath;
	const warnings: string[] = [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return { config: parseConfig(raw, warnings), warnings, path };
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code !== "ENOENT" || overridePath) {
			warnings.push(
				`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {
			config: structuredClone(DEFAULT_SESSION_UI_CONFIG),
			warnings,
			path,
		};
	}
}
