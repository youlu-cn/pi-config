/**
 * Sticky user message header for fullscreen TUI.
 *
 * After a userMessage's first text line scrolls off the top of the viewport, pin
 * that line to the viewport top (single-line ellipsis) until the next user
 * message scrolls off and takes over. Click jumps back to the message start.
 * Regular (non-fullscreen) terminals own their own scrollback and do not participate.
 *
 * Ported from pi-cc-extensions sticky-prompt (MIT), adapted for session-ui:
 * Symbol.for patches, session-ui markers (`\x1b_su:p` / `\x1b_su:P`), and a
 * minimal sticky-only mouse path (no tool hover / scroll-dock button).
 */

import {
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	stripTerminalSequences,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { hasActiveTextPreview } from "./context.ts";
import {
	isSgrIdleMotion,
	isSgrLeftPress,
	parseSgrMousePackets,
	type SgrMousePacket,
} from "./sgr-mouse.ts";

/** Zero-width APC markers; terminals ignore them, stripped before composite. */
const MESSAGE_START = "\x1b_su:p\x07";
const MESSAGE_END = "\x1b_su:P\x07";
const MESSAGE_MARKER_RE = /\x1b_su:[pP]\x07/g;
/** Kitty/iTerm2 image rows: compositing would corrupt image data. */
const KITTY_IMAGE = "\x1b_G";
const ITERM2_IMAGE = "\x1b]1337;File=";

const STICKY_LEAD = " ";
const STICKY_HINT_TEXT = " [click to jump]";
/** Below this width drop the click hint so the body still fits. */
const STICKY_HINT_MIN_WIDTH = 24;

const STATE_KEY = Symbol.for("session-ui.stickyUserMessage.state");
const MARKER_PATCH_KEY = Symbol.for("session-ui.stickyUserMessage.markerPatch");
const FRAME_PATCH_KEY = Symbol.for("session-ui.stickyUserMessage.framePatch");
const FULLSCREEN_KEY = Symbol.for("session-ui.stickyUserMessage.fullscreen");
const ENABLED_KEY = Symbol.for("session-ui.stickyUserMessage.enabled");
const VIEWPORT_PATCH_KEY = Symbol.for("session-ui.stickyUserMessage.viewportPatch");
const MOTION_ENABLED_KEY = Symbol.for("session-ui.stickyUserMessage.motionEnabled");

const WIDGET_KEY = "session-ui.stickyUserMessage";
const MOTION_ENABLE = "\x1b[?1003h\x1b[?1006h";
const MOTION_DISABLE = "\x1b[?1003l";

type StickyPromptState = {
	/** Latest layout object; identity-compared before acting on cached rows. */
	layout: any;
	visible: boolean;
	hovered: boolean;
	row: number;
	x: number;
	width: number;
	jumpRow: number;
	text: string;
	theme: any;
};

type StickyPatch = {
	active: boolean;
	original: (...args: any[]) => any;
	installed: (...args: any[]) => any;
};

function stickyState(): StickyPromptState {
	const g = globalThis as any;
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = {
			layout: null,
			visible: false,
			hovered: false,
			row: -1,
			x: 0,
			width: 0,
			jumpRow: 0,
			text: "",
			theme: null,
		} satisfies StickyPromptState;
	}
	return g[STATE_KEY] as StickyPromptState;
}

function getEnabled(): boolean {
	const fn = (globalThis as any)[ENABLED_KEY] as (() => boolean) | undefined;
	return typeof fn === "function" ? fn() : true;
}

function setEnabledGetter(isEnabled: () => boolean): void {
	(globalThis as any)[ENABLED_KEY] = isEnabled;
}

/** Mirror cc's isToolTuiFullscreen: default true until explicitly set false. */
export function isFullscreenActive(): boolean {
	return (globalThis as any)[FULLSCREEN_KEY] !== false;
}

export function setFullscreenActive(value: boolean): void {
	(globalThis as any)[FULLSCREEN_KEY] = value;
}

export function setStickyPromptTheme(theme: any): void {
	stickyState().theme = theme;
}

export function resetStickyPromptState(): void {
	const state = stickyState();
	state.layout = null;
	state.visible = false;
	state.hovered = false;
}

function stickyPromptActive(): boolean {
	return getEnabled();
}

function setStickyHovered(hovered: boolean): boolean {
	const state = stickyState();
	if (state.hovered === hovered) return false;
	state.hovered = hovered;
	return true;
}

function lineText(line: string): string {
	return stripTerminalSequences(line).trim();
}

function isImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE) || line.includes(ITERM2_IMAGE);
}

type PromptCursor = {
	start: number;
	textRow: number;
};

/** Cap for scanning message body lines; beyond this, treat as empty. */
const PROMPT_TEXT_SCAN_LIMIT = 64;

/**
 * Nearest userMessage above the viewport top is the current prompt.
 * END markers are ignored for takeover — stick until the next START scrolls off.
 */
function scanPrompt(lines: readonly string[], row: number): PromptCursor | null {
	let start = -1;
	for (let i = Math.min(row, lines.length - 1); i >= 0; i--) {
		if ((lines[i] ?? "").includes(MESSAGE_START)) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const textRow = findPromptTextRow(lines, start);
	return textRow < 0 ? null : { start, textRow };
}

/** First non-empty body line within the message; END marks the message bound. */
function findPromptTextRow(lines: readonly string[], start: number): number {
	const end = findMessageEnd(lines, start);
	if (end < 0) return -1;
	for (let i = start; i <= end; i++) {
		if (lineText(lines[i] ?? "") !== "") return i;
	}
	return -1;
}

function findMessageEnd(lines: readonly string[], start: number): number {
	const limit = Math.min(lines.length - 1, start + PROMPT_TEXT_SCAN_LIMIT);
	for (let i = start; i <= limit; i++) {
		if ((lines[i] ?? "").includes(MESSAGE_END)) return i;
	}
	return -1;
}

/** Prefer the scrollView reference; fall back to the first scroll box with content. */
function findScrollBox(box: any, scrollView: any): any {
	let fallback: any = null;
	const visit = (node: any): any => {
		if (!node) return null;
		if (scrollView && node.scrollView === scrollView) return node;
		if (
			!fallback &&
			Array.isArray(node.scrollContentLines) &&
			node.scrollContentLines.length > 0
		) {
			fallback = node;
		}
		for (const child of node.children ?? []) {
			const hit = visit(child);
			if (hit) return hit;
		}
		return null;
	};
	return visit(box) ?? fallback;
}

export type StickyPromptInfo = {
	row: number;
	x: number;
	width: number;
	jumpRow: number;
	text: string;
};

/**
 * Screen row/col of the scrollbar track's top cell. Returns null when that cell
 * is the thumb, the track is unreachable, or there is no scrollbar. Clicking the
 * top track cell would jump Pi to the session start.
 */
export function scrollbarTopTrackCell(box: any): { row: number; col: number } | null {
	const view = box?.scrollView;
	const rect = box?.rect;
	const clip = box?.clip;
	if (!view?.isScrollbarVisible || !rect || !clip || rect.width <= 0 || rect.height <= 0)
		return null;
	const column = rect.x + rect.width - 1;
	if (column < clip.x || column >= clip.x + clip.width) return null;
	const contentHeight = box.children?.[0]?.rect?.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = rect.height;
	if (contentHeight <= 0) return null;
	const thumbHeight = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const scrollTop = Number(view.scrollTop ?? 0);
	const thumbTop =
		rect.y + (maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbTop));
	return thumbTop > clip.y ? { row: clip.y, col: column } : null;
}

/** When the viewport top sits below a userMessage, return sticky bar geometry + text. */
export function computeStickyPrompt(tui: any, layout: any): StickyPromptInfo | null {
	if (!layout?.root) return null;
	const scrollView = layout.primaryScrollView ?? tui?.getPrimaryScrollView?.();
	const box = findScrollBox(layout.root, scrollView);
	const lines = box?.scrollContentLines as readonly string[] | undefined;
	const clip = box?.clip;
	if (!box || !Array.isArray(lines) || !clip || clip.width <= 0 || clip.height <= 0) return null;
	const scrollTop = Math.max(0, Math.floor(Number(box.scrollView?.scrollTop ?? 0)));
	if (scrollTop <= 0) return null;
	const cursor = scanPrompt(lines, scrollTop);
	if (!cursor) return null;
	if (cursor.textRow >= scrollTop) return null;
	const scrollbar = box.scrollView?.isScrollbarVisible === true && clip.width > 1;
	return {
		row: clip.y,
		x: clip.x,
		width: scrollbar ? clip.width - 1 : clip.width,
		jumpRow: cursor.start,
		text: lineText(lines[cursor.textRow] ?? ""),
	};
}

/**
 * Full-width sticky bar: body + click hint (leading space aligns with message body).
 * truncateToWidth inserts a style reset at the cut — strip it before wrapping bg.
 */
export function stickyPromptBar(text: string, width: number, hovered: boolean, theme: any): string {
	const hint = width >= STICKY_HINT_MIN_WIDTH ? STICKY_HINT_TEXT : "";
	const room = Math.max(0, width - visibleWidth(STICKY_LEAD) - visibleWidth(hint));
	const body = stripTerminalSequences(truncateToWidth(text, room, "…"));
	const pad = " ".repeat(
		Math.max(0, width - visibleWidth(STICKY_LEAD) - visibleWidth(body) - visibleWidth(hint)),
	);
	const plain = STICKY_LEAD + body + pad + hint;
	try {
		if (typeof theme?.fg !== "function" || typeof theme?.bg !== "function") return plain;
		return theme.bg("userMessageBg", theme.fg(hovered ? "text" : "dim", plain));
	} catch {
		return plain;
	}
}

function stripMessageMarkers(lines: string[]): string[] {
	const dirty = lines.some(
		(line) =>
			typeof line === "string" && (line.includes(MESSAGE_START) || line.includes(MESSAGE_END)),
	);
	return dirty ? lines.map((line) => line.replace(MESSAGE_MARKER_RE, "")) : lines;
}

/**
 * TuiAltScreen frame-composite hook: strip markers, then overlay the sticky bar
 * on the viewport top row (before diff compare so hover/jump enter the delta).
 */
export function renderStickyPromptScreen(
	tui: any,
	screen: string[],
	layout: any,
	terminalWidth: number,
): string[] {
	const stripped = stripMessageMarkers(screen);
	const state = stickyState();
	const info = stickyPromptActive() ? computeStickyPrompt(tui, layout) : null;
	const sameTarget = Boolean(
		info && state.visible && state.row === info.row && state.jumpRow === info.jumpRow,
	);
	state.layout = layout;
	state.visible = Boolean(info);
	if (!info) {
		state.hovered = false;
		return stripped;
	}
	state.row = info.row;
	state.x = info.x;
	state.width = info.width;
	state.jumpRow = info.jumpRow;
	state.text = info.text;
	if (!sameTarget) state.hovered = false;
	if (info.row < 0 || info.row >= stripped.length) return stripped;
	const base = stripped[info.row] ?? "";
	if (isImageLine(base)) return stripped;
	const bar = stickyPromptBar(info.text, info.width, state.hovered, state.theme);
	const next = [...stripped];
	next[info.row] = compositeTuiLine(base, bar, info.x, info.width, terminalWidth);
	return next;
}

/** Row+col fall inside this frame's sticky bar (scrollbar column is outside). */
export function stickyBarHit(tui: any, packet: SgrMousePacket): boolean {
	const state = stickyState();
	if (!stickyPromptActive() || !state.visible || state.layout !== tui?.currentLayout) return false;
	if (packet.row - 1 !== state.row) return false;
	const col = packet.col - 1;
	return col >= state.x && col < state.x + state.width;
}

/**
 * Update sticky hover. Returns true when the pointer is on the bar (caller can
 * skip other hover handling). Hover changes request a re-render.
 */
export function updateStickyPromptHover(tui: any, packet: SgrMousePacket): boolean {
	const onBar = stickyBarHit(tui, packet);
	if (setStickyHovered(onBar)) tui.requestRender?.();
	return onBar;
}

/**
 * Top scrollbar-track cell press while sticky is visible: swallow so Pi does not
 * jump to session start. Thumb-at-top is not blocked.
 */
export function scrollbarTopTrackHit(tui: any, packet: SgrMousePacket): boolean {
	if (!stickyPromptActive()) return false;
	const state = stickyState();
	if (!state.visible || state.layout !== tui?.currentLayout) return false;
	const box = findScrollBox(tui?.currentLayout?.root, tui?.getPrimaryScrollView?.());
	const cell = scrollbarTopTrackCell(box);
	if (!cell) return false;
	return state.row === cell.row && packet.row - 1 === cell.row && packet.col - 1 === cell.col;
}

/** Click sticky bar → scrollTo jumpRow. No scroll-dock button. */
export function handleStickyPromptClick(tui: any, packet: SgrMousePacket): boolean {
	const state = stickyState();
	if (scrollbarTopTrackHit(tui, packet)) return true;
	if (!stickyBarHit(tui, packet)) return false;
	const view = tui.getPrimaryScrollView?.();
	if (typeof view?.scrollTo === "function") {
		view.scrollTo(state.jumpRow, { disableFollow: true });
	}
	state.visible = false;
	state.hovered = false;
	tui.requestRender?.();
	return true;
}

/** This module instance's patches — dispose only restores what we installed. */
let markerPatch: StickyPatch | null = null;
let framePatch: StickyPatch | null = null;

/** Inject zero-width markers into UserMessageComponent.render (fullscreen only). */
export function installStickyPromptMarkerPatch(): void {
	const prototype = (UserMessageComponent as any)?.prototype;
	if (typeof prototype?.render !== "function") return;
	const previous = (globalThis as any)[MARKER_PATCH_KEY] as StickyPatch | undefined;
	if (previous) previous.active = false;
	const original =
		previous && prototype.render === previous.installed ? previous.original : prototype.render;
	const patch: StickyPatch = {
		active: true,
		original,
		installed(this: any, width: number) {
			const lines = original.call(this, width);
			if (!patch.active || !isFullscreenActive() || !stickyPromptActive()) return lines;
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			lines[0] += MESSAGE_START;
			lines[lines.length - 1] += MESSAGE_END;
			return lines;
		},
	};
	prototype.render = patch.installed;
	(globalThis as any)[MARKER_PATCH_KEY] = patch;
	markerPatch = patch;
}

/** Wrap TuiAltScreen.compositeScrollToEndIndicator. Returns whether install succeeded. */
export function installStickyPromptFramePatch(): boolean {
	const prototype = (TuiAltScreen as any)?.prototype;
	if (typeof prototype?.compositeScrollToEndIndicator !== "function") return false;
	const previous = (globalThis as any)[FRAME_PATCH_KEY] as StickyPatch | undefined;
	if (previous) previous.active = false;
	const original =
		previous && prototype.compositeScrollToEndIndicator === previous.installed
			? previous.original
			: prototype.compositeScrollToEndIndicator;
	const patch: StickyPatch = {
		active: true,
		original,
		installed(this: any, screen: string[], layout: any, width: number) {
			const result = original.call(this, screen, layout, width);
			if (!patch.active) return result;
			return renderStickyPromptScreen(this, result, layout, width);
		},
	};
	prototype.compositeScrollToEndIndicator = patch.installed;
	(globalThis as any)[FRAME_PATCH_KEY] = patch;
	framePatch = patch;
	return true;
}

export function installStickyPromptPatches(isEnabled: () => boolean = getEnabled): void {
	setEnabledGetter(isEnabled);
	// Markers need a consumer: if the frame patch cannot install, do not inject.
	if (installStickyPromptFramePatch()) installStickyPromptMarkerPatch();
}

export function disposeStickyPromptPatches(): void {
	disposeStickyPatch(
		MARKER_PATCH_KEY,
		markerPatch,
		(UserMessageComponent as any)?.prototype,
		"render",
	);
	disposeStickyPatch(
		FRAME_PATCH_KEY,
		framePatch,
		(TuiAltScreen as any)?.prototype,
		"compositeScrollToEndIndicator",
	);
	markerPatch = null;
	framePatch = null;
	resetStickyPromptState();
}

function disposeStickyPatch(
	key: symbol,
	patch: StickyPatch | null,
	prototype: any,
	method: string,
): void {
	if (!patch) return;
	patch.active = false;
	if ((globalThis as any)[key] !== patch) return;
	if (prototype && prototype[method] === patch.installed) prototype[method] = patch.original;
	delete (globalThis as any)[key];
}

// ---- Minimal sticky-only mouse ---------------------------------------------

type ViewportPatch = {
	tui: any;
	original: (data: string) => unknown;
};

let viewportPatch: ViewportPatch | null = null;
let motionTerminal: { write?: (data: string) => void } | null = null;
let ownsMotion = false;
let widgetUi: { setWidget?: (key: string, content: any) => void } | null = null;

function officialFullscreenHasAllMotion(): boolean {
	const term = process.env.TERM?.toLowerCase() ?? "";
	return !(
		process.env.TMUX !== undefined ||
		process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
}

function enableStickyMotion(tui: any): void {
	if (
		!tui ||
		tui.mode !== "fullscreen" ||
		tui.mouseEnabled === false ||
		tui.altScreenActive === false ||
		tui[MOTION_ENABLED_KEY]
	) {
		return;
	}
	try {
		tui.terminal?.write?.(MOTION_ENABLE);
		tui[MOTION_ENABLED_KEY] = true;
		motionTerminal = tui.terminal ?? null;
		ownsMotion = !officialFullscreenHasAllMotion();
	} catch {
		// Terminal may be switching or already closed.
	}
}

function releaseStickyMotion(tui?: any): void {
	try {
		if (tui?.[MOTION_ENABLED_KEY]) tui[MOTION_ENABLED_KEY] = false;
	} catch {
		// Lazy proxy may already point elsewhere.
	}
	const terminal = motionTerminal;
	const shouldDisable = ownsMotion;
	motionTerminal = null;
	ownsMotion = false;
	try {
		if (shouldDisable) terminal?.write?.(MOTION_DISABLE);
	} catch {
		// Terminal may already be closed.
	}
}

function patchViewportInput(tui: any): void {
	if (!tui || tui[VIEWPORT_PATCH_KEY]) return;
	const proto = Object.getPrototypeOf(tui);
	const original = proto?.handleViewportInput;
	if (typeof original !== "function") return;
	tui[VIEWPORT_PATCH_KEY] = true;
	const wrapped = function (this: any, data: string) {
		if (stickyPromptActive() && tui.mode === "fullscreen" && !hasActiveTextPreview()) {
			const packets = parseSgrMousePackets(data);
			if (packets) {
				for (const packet of packets) {
					if (isSgrLeftPress(packet) && handleStickyPromptClick(tui, packet)) {
						return { consume: true };
					}
					if (isSgrIdleMotion(packet)) {
						updateStickyPromptHover(tui, packet);
					}
				}
			}
		}
		return Reflect.apply(original, this, [data]);
	};
	tui.handleViewportInput = wrapped;
	viewportPatch = { tui, original };
}

function restoreViewportInput(tui?: any): void {
	const target = tui ?? viewportPatch?.tui;
	if (!target || !target[VIEWPORT_PATCH_KEY]) {
		viewportPatch = null;
		return;
	}
	const proto = Object.getPrototypeOf(target);
	if (typeof proto?.handleViewportInput === "function") {
		target.handleViewportInput = proto.handleViewportInput;
	}
	target[VIEWPORT_PATCH_KEY] = false;
	viewportPatch = null;
}

function installStickyMouse(ctx: any): void {
	teardownStickyMouse();
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.setWidget !== "function") return;
	widgetUi = ctx.ui;
	setStickyPromptTheme(ctx.ui.theme);
	ctx.ui.setWidget(WIDGET_KEY, (tui: any, theme: any) => {
		setStickyPromptTheme(theme);
		const fullscreen = tui?.mode === "fullscreen";
		setFullscreenActive(fullscreen);
		if (fullscreen) {
			patchViewportInput(tui);
			enableStickyMotion(tui);
		} else {
			releaseStickyMotion(tui);
			restoreViewportInput(tui);
		}
		return {
			render: () => [] as string[],
			invalidate() {},
			dispose() {
				releaseStickyMotion(tui);
				restoreViewportInput(tui);
			},
		};
	});
}

function teardownStickyMouse(): void {
	releaseStickyMotion(viewportPatch?.tui);
	restoreViewportInput(viewportPatch?.tui);
	try {
		widgetUi?.setWidget?.(WIDGET_KEY, undefined);
	} catch {
		// UI may already be torn down on /reload.
	}
	widgetUi = null;
}

/**
 * Install patches early (first paint) and wire fullscreen mouse on session_start.
 * Dispose is reload-safe: only this instance's patches are restored.
 */
export function registerStickyUserMessage(pi: ExtensionAPI, isEnabled: () => boolean): void {
	installStickyPromptPatches(isEnabled);

	pi.on("session_start", async (_event, ctx) => {
		if (!isEnabled()) return;
		installStickyMouse(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!isEnabled()) return;
		installStickyMouse(ctx);
	});

	pi.on("session_shutdown", async () => {
		teardownStickyMouse();
		disposeStickyPromptPatches();
		setFullscreenActive(false);
	});
}

export default registerStickyUserMessage;

/** Test helpers: markers used by unit tests. */
export const STICKY_MESSAGE_START = MESSAGE_START;
export const STICKY_MESSAGE_END = MESSAGE_END;
