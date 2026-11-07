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
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

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

function animateDots(frame: number): string {
	return ".".repeat((frame % 3) + 1);
}

const expandedThinking = new Set<string>();

class ThinkingPreviewBlock implements Component {
	constructor(
		private heading: string,
		private text: string,
		private padding: number,
		private messageTimestamp: number,
		private runStartIndex: number,
		private style: (text: string) => string,
		private theme: Theme | undefined,
		private active: boolean,
		private previewLines: number,
		private completedPreviewLines: number,
	) {}

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

	private effectivePreview(): number {
		return this.active ? this.previewLines : this.completedPreviewLines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = this.padding;
		const contentWidth = Math.max(1, width - pad * 2);
		const hint = this.expanded
			? " · click to collapse"
			: this.text
				? " · click to expand"
				: "";
		const hintStyled = this.theme ? this.theme.fg("dim", hint) : hint;
		const headingBudget = Math.max(8, contentWidth - visibleWidth(hint));
		const heading =
			visibleWidth(this.heading) > headingBudget
				? truncateToWidth(this.heading, headingBudget, "")
				: this.heading;
		const headerLine = `${" ".repeat(pad)}${heading}${hintStyled}`;

		const previewLimit = this.effectivePreview();
		const body: string[] = [];
		if (this.text && (this.expanded || previewLimit > 0)) {
			const wrapped = wrapTextWithAnsi(this.text.replace(/\t/g, "   "), contentWidth);
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

		const out = [headerLine, ...body];
		return new MouseRegion(
			{ render: () => out, invalidate() {} },
			(event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true, render: true };
			},
		).render(width);
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
};

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
	};

	const previous = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	if (previous?.active && prototype.updateContent === previous.installed) {
		previous.active = false;
		prototype.updateContent = previous.original;
	}

	const config: CompactThinkingConfig = { ...initial };
	const original =
		previous && prototype.updateContent === previous.installed
			? previous.original
			: prototype.updateContent;

	let activeTheme: Theme | undefined;
	let activeTui: { requestRender(force?: boolean): void } | undefined;
	let activeThinking: ActiveThinking | null = null;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let animationFrame = 0;
	const streamingComponents = new Set<object>();
	const completedDurations = new Map<string, number>();
	let latestComponent: object | undefined;
	let latestTimestamp: number | undefined;

	function ensureAnimation() {
		if (animationTimer || !config.enabled) return;
		animationTimer = setInterval(() => {
			animationFrame++;
			for (const component of streamingComponents) {
				const self = component as unknown as AssistantInternals;
				if (self.lastMessage) self.updateContent(self.lastMessage);
			}
			activeTui?.requestRender();
		}, config.animationIntervalMs);
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

		if (activeThinking?.messageTimestamp === message.timestamp) {
			streamingComponents.add(this);
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

			let heading: string;
			if (active) {
				const label = (self.hiddenThinkingLabel || "Thinking").replace(/\.*$/, "");
				heading =
					styleFn(`${label}${animateDots(animationFrame)}`) +
					(durationText ? styleFn(` · ${durationText}`) : "");
			} else {
				heading = styleFn(durationText ? `Thought for ${durationText}` : "Thought");
			}

			const completedPreview =
				config.completedPreviewLines == null
					? config.previewLines
					: config.completedPreviewLines;

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

	const installed = prototype.updateContent;
	(globalThis as any)[PATCH_KEY] = {
		active: true,
		installed,
		original,
	} satisfies PatchState;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			activeTheme = ctx.ui.theme as Theme;
			try {
				activeTui = (ctx.ui as { tui?: { requestRender(force?: boolean): void } }).tui;
			} catch {
				activeTui = undefined;
			}
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (!config.enabled) return;
		if (ctx.hasUI) {
			activeTheme = (ctx.ui.theme as Theme) ?? activeTheme;
			try {
				activeTui = (ctx.ui as { tui?: { requestRender(force?: boolean): void } }).tui ?? activeTui;
			} catch {
				/* ignore */
			}
		}
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
			animationFrame = 0;
			streamingComponents.clear();
			if (latestComponent && latestTimestamp === activeThinking.messageTimestamp) {
				streamingComponents.add(latestComponent);
				const self = latestComponent as unknown as AssistantInternals;
				if (self.lastMessage) self.updateContent(self.lastMessage);
			}
			ensureAnimation();
			activeTui?.requestRender();
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
				streamingComponents.clear();
				stopAnimationIfIdle();
				if (latestComponent) {
					const self = latestComponent as unknown as AssistantInternals;
					if (self.lastMessage) self.updateContent(self.lastMessage);
				}
				activeTui?.requestRender();
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
			streamingComponents.clear();
			stopAnimationIfIdle();
		}
	});

	const hooks: CompactThinkingHooks = {
		updateConfig(next) {
			Object.assign(config, next);
			if (!config.enabled) {
				activeThinking = null;
				streamingComponents.clear();
				stopAnimationIfIdle();
			}
		},
		shutdown() {
			const patch = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
			if (!patch?.active) return;
			patch.active = false;
			activeThinking = null;
			streamingComponents.clear();
			if (animationTimer) clearInterval(animationTimer);
			animationTimer = undefined;
			activeTheme = undefined;
			activeTui = undefined;
			if (prototype.updateContent === installed) {
				prototype.updateContent = original;
			}
		},
	};

	pi.on("session_shutdown", () => {
		hooks.shutdown();
	});

	return hooks;
}
