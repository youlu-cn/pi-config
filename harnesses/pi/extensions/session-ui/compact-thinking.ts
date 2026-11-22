/**
 * Compact thinking: when thinking is hidden (Ctrl+T), show an animated title
 * plus N preview lines instead of a bare label. Click expands/collapses.
 *
 * Simplified from pi-cc-extensions / pi-compact-thinking (MIT).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { renderShimmerText } from "./compact-thinking-anim.ts";

export interface CompactThinkingConfig {
	enabled: boolean;
	previewLines: number;
	completedPreviewLines: number | null;
	animationIntervalMs: number;
}

export const DEFAULT_COMPACT_THINKING: CompactThinkingConfig = {
	enabled: true,
	previewLines: 3,
	completedPreviewLines: 1,
	animationIntervalMs: 90,
};

const PATCH_KEY = Symbol.for("session-ui.compactThinking.patch");
const PARENT_KEY = Symbol.for("session-ui.toolGroup.parent");

type MarkdownTransformer = (
	markdown: string,
	context: {
		messageType: "user" | "assistant" | "assistant-thinking";
		isStreaming: boolean;
		availableWidth: number;
		messageId?: string;
	},
) => string;

type AssistantInternals = {
	contentContainer: { clear(): void; addChild(component: Component): void };
	hideThinkingBlock: boolean;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hiddenThinkingLabel: string;
	outputPad: number;
	isStreaming: boolean;
	markdownTransformers: readonly MarkdownTransformer[];
	lastMessage?: AssistantMessage;
	hasToolCalls: boolean;
	messageId?: string;
	timestamp?: number;
	updateContent(message: AssistantMessage): void;
};

type ActiveThinking = {
	messageTimestamp: number;
	contentIndex: number;
	startedAt: number;
};

function formatThoughtDuration(ms: number): string {
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function styleThinking(text: string, theme: Theme | undefined): string {
	if (!theme) return text;
	return theme.italic(theme.fg("thinkingText", text));
}

const expandedThinking = new Set<string>();

type ThinkingBlockSnapshot = {
	heading: string;
	text: string;
	active: boolean;
	activeLabel: string;
	startedAt?: number;
};

class ThinkingPreviewBlock implements Component {
	private heading: string;
	private text: string;
	private padding: number;
	private messageTimestamp: number;
	private runStartIndex: number;
	private style: (text: string) => string;
	private theme: Theme | undefined;
	private active: boolean;
	private previewLines: number;
	private completedPreviewLines: number;
	private activeLabel: string;
	private startedAt?: number;
	private onToggle?: () => void;
	private resolveSnapshot?: () => ThinkingBlockSnapshot | undefined;

	constructor(
		heading: string,
		text: string,
		padding: number,
		messageTimestamp: number,
		runStartIndex: number,
		style: (text: string) => string,
		theme: Theme | undefined,
		active: boolean,
		previewLines: number,
		completedPreviewLines: number,
		activeLabel = "Thinking",
		startedAt?: number,
		onToggle?: () => void,
		resolveSnapshot?: () => ThinkingBlockSnapshot | undefined,
	) {
		this.heading = heading;
		this.text = text;
		this.padding = padding;
		this.messageTimestamp = messageTimestamp;
		this.runStartIndex = runStartIndex;
		this.style = style;
		this.theme = theme;
		this.active = active;
		this.previewLines = previewLines;
		this.completedPreviewLines = completedPreviewLines;
		this.activeLabel = activeLabel;
		this.startedAt = startedAt;
		this.onToggle = onToggle;
		this.resolveSnapshot = resolveSnapshot;
	}

	private key(): string {
		return `${this.messageTimestamp}:${this.runStartIndex}`;
	}

	get expanded(): boolean {
		return expandedThinking.has(this.key());
	}

	setExpanded(expanded: boolean): void {
		if (expanded) expandedThinking.add(this.key());
		else expandedThinking.delete(this.key());
	}

	handleMouse(event: { type?: string; button?: string }): { handled: boolean; render?: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		this.onToggle?.();
		return { handled: true, render: true };
	}

	private effectivePreview(active: boolean): number {
		return active ? this.previewLines : this.completedPreviewLines;
	}

	private currentHeading(snap: ThinkingBlockSnapshot): string {
		if (!snap.active) return snap.heading;
		const elapsedMs = Math.max(0, Date.now() - (snap.startedAt ?? Date.now()));
		const shimmer = renderShimmerText(snap.activeLabel, elapsedMs, this.theme);
		const durationText = formatThoughtDuration(Math.max(1, elapsedMs));
		return shimmer + this.style(` · ${durationText}`);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const snap = this.resolveSnapshot?.() ?? {
			heading: this.heading,
			text: this.text,
			active: this.active,
			activeLabel: this.activeLabel,
			startedAt: this.startedAt,
		};
		const pad = this.padding;
		const contentWidth = Math.max(1, width - pad * 2);
		const hint = this.expanded
			? " · click to collapse"
			: snap.text
				? " · click to expand"
				: "";
		const hintStyled = this.theme ? this.theme.fg("dim", hint) : hint;
		const headingBudget = Math.max(8, contentWidth - visibleWidth(hint));
		const rawHeading = this.currentHeading(snap);
		const heading =
			visibleWidth(rawHeading) > headingBudget
				? truncateToWidth(rawHeading, headingBudget, "")
				: rawHeading;
		const headerLine = `${" ".repeat(pad)}${heading}${hintStyled}`;

		const previewLimit = this.effectivePreview(snap.active);
		const body: string[] = [];
		if (snap.text && (this.expanded || previewLimit > 0)) {
			const wrapped = wrapTextWithAnsi(snap.text.replace(/\t/g, "   "), contentWidth);
			const lines = this.expanded ? wrapped : wrapped.slice(-Math.max(0, previewLimit));
			const hidden = this.expanded ? 0 : Math.max(0, wrapped.length - lines.length);
			for (const line of lines) {
				body.push(`${" ".repeat(pad)}${this.style(line)}`);
			}
			if (hidden > 0 && !this.expanded) {
				body.push(
					this.theme
						? this.theme.fg("dim", `${" ".repeat(pad)}… ${hidden} more lines`)
						: `${" ".repeat(pad)}… ${hidden} more lines`,
				);
			}
		}

		return [headerLine, ...body];
	}
}

function createTransform(
	messageType: "assistant" | "assistant-thinking",
	self: AssistantInternals,
): MarkdownTransformer {
	return (markdown, context) => {
		let next = markdown;
		for (const t of self.markdownTransformers) {
			next = t(next, {
				...context,
				messageType,
				isStreaming: self.isStreaming,
				messageId: self.messageId,
			});
		}
		return next;
	};
}

type PatchState = {
	active: boolean;
	installed: (message: AssistantMessage, isStreaming?: boolean) => void;
	original: (message: AssistantMessage, isStreaming?: boolean) => void;
	installedRender: (width: number) => string[];
	originalRender: (width: number) => string[];
};

function isSpacerNode(node: unknown): boolean {
	return typeof node === "object" && node !== null && (node as any).constructor?.name === "Spacer";
}

function isThinkingOnlyAssistant(node: unknown): boolean {
	if (typeof node !== "object" || node === null) return false;
	const comp = node as unknown as AssistantInternals;
	if (!comp.hideThinkingBlock) return false;
	const msg = comp.lastMessage;
	if (!msg || !Array.isArray(msg.content)) return false;
	let hasThinking = false;
	for (const block of msg.content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			return false;
		}
		if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
			hasThinking = true;
		}
	}
	return hasThinking;
}

function isMergedThinkingFollower(comp: any): boolean {
	if (!isThinkingOnlyAssistant(comp)) return false;
	const parent = comp?.[PARENT_KEY];
	const children = parent?.children;
	if (!Array.isArray(children)) return false;
	const index = children.indexOf(comp);
	if (index <= 0) return false;
	for (let i = index - 1; i >= 0; i--) {
		const prev = children[i];
		if (prev == null || isSpacerNode(prev)) continue;
		return isThinkingOnlyAssistant(prev);
	}
	return false;
}

function collectThinkingChain(leader: any): any[] {
	const parent = leader?.[PARENT_KEY];
	const children = parent?.children;
	if (!Array.isArray(children)) return [leader];
	const index = children.indexOf(leader);
	if (index < 0) return [leader];
	const chain = [leader];
	for (let i = index + 1; i < children.length; i++) {
		const next = children[i];
		if (next == null || isSpacerNode(next)) continue;
		if (!isThinkingOnlyAssistant(next)) break;
		chain.push(next);
	}
	return chain;
}

export type CompactThinkingHooks = {
	updateConfig(next: Partial<CompactThinkingConfig>): void;
	shutdown(): void;
};

export function installCompactThinking(
	pi: ExtensionAPI,
	initial: CompactThinkingConfig = DEFAULT_COMPACT_THINKING,
): CompactThinkingHooks {
	const prototype = AssistantMessageComponent.prototype as unknown as {
		updateContent: (message: AssistantMessage, isStreaming?: boolean) => void;
		render: (width: number) => string[];
	};

	const previous = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	if (previous?.active) {
		previous.active = false;
		if (prototype.updateContent === previous.installed) {
			prototype.updateContent = previous.original;
		}
		if (prototype.render === previous.installedRender) {
			prototype.render = previous.originalRender;
		}
	}

	const config: CompactThinkingConfig = { ...initial };
	const original =
		previous && prototype.updateContent === previous.installed
			? previous.original
			: prototype.updateContent;
	const originalRender =
		previous && prototype.render === previous.installedRender
			? previous.originalRender
			: prototype.render;

	let activeTheme: Theme | undefined;
	let requestRender: (() => void) | undefined;
	let activeThinking: ActiveThinking | null = null;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const completedDurations = new Map<string, number>();
	let latestComponent: object | undefined;
	let latestTimestamp: number | undefined;

	function ensureAnimation() {
		if (animationTimer || !config.enabled) return;
		const intervalMs = Math.max(40, Math.min(config.animationIntervalMs, 60));
		animationTimer = setInterval(() => {
			if (!activeThinking) return;
			requestRender?.();
		}, intervalMs);
		animationTimer.unref?.();
	}

	function stopAnimationIfIdle() {
		if (activeThinking || !animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	}

	function durationKey(ts: number, index: number): string {
		return `${ts}:${index}`;
	}

	prototype.updateContent = function patchedUpdateContent(
		this: any,
		message: AssistantMessage,
		isStreaming?: boolean,
	) {
		const self = this as unknown as AssistantInternals;
		self.isStreaming = isStreaming ?? self.isStreaming;
		self.lastMessage = message;
		latestComponent = this;
		latestTimestamp = message.timestamp;

		// Disabled, or thinking fully visible (Ctrl+T): keep Pi's built-in renderer.
		if (!config.enabled || !self.hideThinkingBlock) {
			return original.call(this, message, self.isStreaming);
		}

		self.contentContainer.clear();
		const styleFn = (text: string) => styleThinking(text, activeTheme);

		let needsSpacer = true;
		const addVisible = (child: Component) => {
			if (needsSpacer) {
				self.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
			}
			self.contentContainer.addChild(child);
		};

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i]!;

			if (content.type === "text" && content.text.trim()) {
				addVisible(
					new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme, undefined, {
						transform: createTransform("assistant", self),
					}),
				);
				continue;
			}

			if (content.type !== "thinking") continue;

			const runStartIndex = i;
			const thinkingBlocks: string[] = [];
			for (; i < message.content.length; i++) {
				const block = message.content[i]!;
				if (block.type !== "thinking") break;
				const thinking = block.thinking.trim();
				if (thinking) thinkingBlocks.push(thinking);
			}
			const runEndIndex = i - 1;
			i--;

			const active =
				activeThinking?.messageTimestamp === message.timestamp &&
				activeThinking.contentIndex >= runStartIndex &&
				activeThinking.contentIndex <= runEndIndex;

			if (thinkingBlocks.length === 0 && !active) continue;

			const elapsedMs = activeThinking
				? Math.max(1, Date.now() - activeThinking.startedAt)
				: undefined;
			const completedMs = completedDurations.get(
				durationKey(message.timestamp, runStartIndex),
			);
			const durationMs = active ? elapsedMs : completedMs;
			const durationText =
				durationMs === undefined ? undefined : formatThoughtDuration(durationMs);

			const label = (self.hiddenThinkingLabel || "Thinking").replace(/\.*$/, "") || "Thinking";
			let heading: string;
			if (active) {
				const elapsed = activeThinking ? Math.max(1, Date.now() - activeThinking.startedAt) : 0;
				heading =
					renderShimmerText(label, elapsed, activeTheme) +
					(durationText ? styleFn(` · ${durationText}`) : "");
			} else {
				heading = styleFn(durationText ? `Thought for ${durationText}` : "Thought");
			}

			const completedPreview =
				config.completedPreviewLines == null
					? config.previewLines
					: config.completedPreviewLines;

			const selfComponent = this;
			const resolveSnapshot = (): ThinkingBlockSnapshot | undefined => {
				if (!isThinkingOnlyAssistant(selfComponent)) return undefined;
				const chain = collectThinkingChain(selfComponent);
				if (chain.length <= 1) return undefined;

				const texts: string[] = [];
				let anyActive = false;
				let activeStartedAt: number | undefined;
				let totalCompletedMs = 0;
				let hasCompleted = false;

				for (const item of chain) {
					const itemMsg = (item as AssistantInternals).lastMessage;
					if (!itemMsg || !Array.isArray(itemMsg.content)) continue;
					let firstThinkingIdx = -1;
					for (let idx = 0; idx < itemMsg.content.length; idx++) {
						const b = itemMsg.content[idx]!;
						if (b.type === "thinking") {
							if (firstThinkingIdx < 0) firstThinkingIdx = idx;
							const t = b.thinking.trim();
							if (t) texts.push(t);
						}
					}
					if (activeThinking && activeThinking.messageTimestamp === itemMsg.timestamp) {
						anyActive = true;
						activeStartedAt =
							activeStartedAt === undefined
								? activeThinking.startedAt
								: Math.min(activeStartedAt, activeThinking.startedAt);
					} else if (firstThinkingIdx >= 0) {
						const dur = completedDurations.get(durationKey(itemMsg.timestamp, firstThinkingIdx));
						if (dur !== undefined) {
							totalCompletedMs += dur;
							hasCompleted = true;
						}
					}
				}

				const stepDuration = anyActive
					? formatThoughtDuration(Math.max(1, Date.now() - (activeStartedAt ?? Date.now())))
					: hasCompleted
						? formatThoughtDuration(totalCompletedMs)
						: undefined;

				return {
					heading: styleFn(stepDuration ? `Thought for ${stepDuration}` : "Thought"),
					text: texts.join("\n\n").trim(),
					active: anyActive,
					activeLabel: label,
					startedAt: activeStartedAt,
				};
			};

			addVisible(
				new ThinkingPreviewBlock(
					heading,
					thinkingBlocks.join("\n\n").trim(),
					self.outputPad,
					message.timestamp,
					runStartIndex,
					styleFn,
					activeTheme,
					Boolean(active),
					config.previewLines,
					completedPreview,
					label,
					active ? activeThinking?.startedAt : undefined,
					() => requestRender?.(),
					resolveSnapshot,
				),
			);
			needsSpacer = true;
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		self.hasToolCalls = hasToolCalls;

		if (message.stopReason === "length") {
			self.contentContainer.addChild(new Spacer(1));
			self.contentContainer.addChild(
				new Text(
					activeTheme
						? activeTheme.fg("error", "Response was truncated before completion.")
						: "Response was truncated before completion.",
					self.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage,
						self.outputPad,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMessage = message.errorMessage || "Unknown error";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme
							? activeTheme.fg("error", `Error: ${errorMessage}`)
							: `Error: ${errorMessage}`,
						self.outputPad,
						0,
					),
				);
			}
		}
	};

	prototype.render = function patchedRender(this: any, width: number) {
		if (config.enabled && this.hideThinkingBlock && isMergedThinkingFollower(this)) {
			return [];
		}
		return originalRender.call(this, width);
	};

	const installed = prototype.updateContent;
	const installedRender = prototype.render;
	(globalThis as any)[PATCH_KEY] = {
		active: true,
		installed,
		original,
		installedRender,
		originalRender,
	} satisfies PatchState;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		activeTheme = ctx.ui.theme;
		// The widget factory exposes the TUI without adding a visible row.
		ctx.ui.setWidget("session-ui:thinking-animation", (tui) => {
			requestRender = () => tui.requestRender();
			return {
				render: () => [],
				invalidate() {},
				dispose() { requestRender = undefined; },
			};
		}, { placement: "belowEditor" });
	});

	pi.on("message_update", (event, ctx) => {
		if (!config.enabled) return;
		if (ctx.hasUI) activeTheme = ctx.ui.theme ?? activeTheme;
		const evt = (event as { assistantMessageEvent?: { type?: string; partial?: AssistantMessage } })
			.assistantMessageEvent;
		if (!evt) return;

		if (evt.type === "thinking_start") {
			const msg = evt.partial;
			let index = 0;
			if (msg?.content) {
				for (let i = msg.content.length - 1; i >= 0; i--) {
					if (msg.content[i]?.type === "thinking") {
						index = i;
						break;
					}
				}
			}
			activeThinking = {
				messageTimestamp: msg?.timestamp ?? Date.now(),
				contentIndex: index,
				startedAt: Date.now(),
			};
			if (latestComponent && latestTimestamp === activeThinking.messageTimestamp) {
				const self = latestComponent as unknown as AssistantInternals;
				if (self.lastMessage) self.updateContent(self.lastMessage);
			}
			ensureAnimation();
			requestRender?.();
		} else if (
			evt.type === "thinking_end" ||
			evt.type === "text_start" ||
			evt.type === "toolcall_start" ||
			evt.type === "done"
		) {
			// Finish active thinking on content boundaries too (text/toolcall),
			// not only thinking_end/done — otherwise the title keeps animating.
			if (activeThinking) {
				completedDurations.set(
					durationKey(activeThinking.messageTimestamp, activeThinking.contentIndex),
					Math.max(1, Date.now() - activeThinking.startedAt),
				);
				activeThinking = null;
				stopAnimationIfIdle();
				if (latestComponent) {
					const self = latestComponent as unknown as AssistantInternals;
					if (self.lastMessage) self.updateContent(self.lastMessage);
				}
				requestRender?.();
			}
		}
	});

	pi.on("message_end", (event) => {
		const msg = (event as { message?: AssistantMessage }).message;
		if (!msg || msg.role !== "assistant") return;
		if (activeThinking && activeThinking.messageTimestamp === msg.timestamp) {
			completedDurations.set(
				durationKey(activeThinking.messageTimestamp, activeThinking.contentIndex),
				Math.max(1, Date.now() - activeThinking.startedAt),
			);
			activeThinking = null;
			stopAnimationIfIdle();
		}
	});

	const hooks: CompactThinkingHooks = {
		updateConfig(next) {
			Object.assign(config, next);
			if (!config.enabled) {
				activeThinking = null;
				stopAnimationIfIdle();
			}
		},
		shutdown() {
			const patch = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
			if (!patch?.active) return;
			patch.active = false;
			activeThinking = null;
			if (animationTimer) clearInterval(animationTimer);
			animationTimer = undefined;
			activeTheme = undefined;
			requestRender = undefined;
			if (prototype.updateContent === installed) {
				prototype.updateContent = original;
			}
			if (prototype.render === installedRender) {
				prototype.render = originalRender;
			}
		},
	};

	pi.on("session_shutdown", () => {
		hooks.shutdown();
	});

	return hooks;
}
